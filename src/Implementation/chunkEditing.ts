//this file will be responsible for handling the editing of the chunks upon the editing of any given file which is either edited or created
const Parser = require('tree-sitter');
import * as path from 'path';
const fs = require('fs');
import * as crypto from 'crypto';

import { ChromaManager } from './ChromaManager';
import { parentPort } from 'worker_threads';

import { chunkStructure, chunkGroupStructure } from '../classes/chunk_structure';
export class chunkEditor {
    public parser: typeof Parser;
    public filePath: string;
    public chunkGroup: chunkGroupStructure[] = [];
    public newSource: string = '';
    public chromaManager: ChromaManager;
    constructor(filePath: string, collectionName: string, chunkGroup: chunkGroupStructure[] = [], chromaDbUrl: string = '') {
        this.parser = new Parser();
        this.filePath = filePath;
        this.chunkGroup = chunkGroup;
        this.initializeParser(filePath);
        this.chromaManager = new ChromaManager(collectionName, chromaDbUrl);
    }
    public initializeParser(filePath: string) {
        this.parser = new Parser();
        const extension = path.extname(filePath).toLowerCase();

        // Load appropriate Tree-sitter language based on file extension
        switch (extension) {
            case '.ts':
            case '.tsx':
                const TypeScript = require('tree-sitter-typescript/typescript');
                this.parser.setLanguage(TypeScript);
                break;
            case '.js':
            case '.jsx':
                const JavaScript = require('tree-sitter-javascript');

                this.parser.setLanguage(JavaScript);
                break;
            // Add more language support as needed
            default:
                throw new Error(`Unsupported file extension: ${extension}`);
        }
    }
    public normalizeText(text: string): string {
        const out: string[] = [];
        let prevWasBlank = false;
        let inBlockComment = false;
        let inString: false | '"' | "'" | '`' = false;
        let inRegex = false;
        let escape = false;
        let blockCommentBuffer = '';
        const lines = text.split(/\r?\n/);

        for (let raw of lines) {
            let line = raw;
            let normalized = '';
            let i = 0;
            let codeBuffer = '';
            let commentBuffer = '';
            let isBlank = /^\s*$/.test(line);

            // Collapse multiple blank lines to one
            if (isBlank) {
                if (!prevWasBlank) {
                    out.push('');
                    prevWasBlank = true;
                }
                continue;
            }
            prevWasBlank = false;

            // State machine for each line
            while (i < line.length) {
                const ch = line[i];
                const next = line[i + 1];

                if (inBlockComment) {
                    blockCommentBuffer += ch;
                    if (ch === '*' && next === '/') {
                        blockCommentBuffer += '/';
                        i++;
                        inBlockComment = false;
                        commentBuffer += blockCommentBuffer;
                        blockCommentBuffer = '';
                    }
                    i++;
                    continue;
                }

                if (inString) {
                    codeBuffer += ch;
                    if (!escape && ch === inString) {
                        inString = false;
                    }
                    escape = !escape && ch === '\\';
                    i++;
                    continue;
                }

                if (inRegex) {
                    codeBuffer += ch;
                    if (!escape && ch === '/') {
                        inRegex = false;
                    }
                    escape = !escape && ch === '\\';
                    i++;
                    continue;
                }

                // Start of string literal
                if (ch === '"' || ch === "'" || ch === '`') {
                    inString = ch;
                    codeBuffer += ch;
                    i++;
                    continue;
                }

                // Start of regex literal
                if (ch === '/' && !(next === '*' || next === '/') && !inString && !inBlockComment && !inRegex) {
                    const before = line.slice(0, i).trim();
                    if (before === '' || /[=\(\[\{:,!\?;]|return\s*$/.test(before)) {
                        inRegex = true;
                        codeBuffer += ch;
                        i++;
                        continue;
                    }
                }

                // Start of block comment
                if (ch === '/' && next === '*') {
                    inBlockComment = true;
                    blockCommentBuffer = '/*';
                    i += 2;
                    continue;
                }

                // Handle all comment types (//, #, /* */)
                if (ch === '#' || (ch === '/' && next === '/')) {
                    // Capture entire comment as-is
                    commentBuffer += line.slice(i);
                    break;
                }

                codeBuffer += ch;
                i++;
            }

            // Only normalize code part (skip comments entirely)
            let codeNorm = codeBuffer
                .replace(/\s+/g, ' ')             // collapse whitespace
                .trimEnd();

            // Preserve leading indent and original comment content
            const indentMatch = raw.match(/^\s*/)!;
            const indent = indentMatch[0];
            normalized = indent + codeNorm + commentBuffer;
            out.push(normalized);
        }

        // Trim any leading/trailing blank lines
        while (out.length && /^\s*$/.test(out[0])) out.shift();
        while (out.length && /^\s*$/.test(out[out.length - 1])) out.pop();
        return out.join('\n');
    }
    public filterChunks(chunks: chunkStructure[]): chunkStructure[] {
        return chunks.filter(chunk => chunk.type !== 'empty_statement' && chunk.type !== 'ERROR');
    }
    public stripAllSpaces(text: string): string {
        // \s matches any whitespace (spaces, tabs, linebreaks); + means “one or more”
        // replace them all with the empty string
        return text.replace(/\s+/g, '');
    }

    public getNodeHash(node: string): string {
        const text = node || '';
        const normalizedText = this.normalizeText(text);
        return crypto
            .createHash('sha256')
            .update(normalizedText, 'utf8')
            .digest('hex');
    }
    public getTextFromRange(start: typeof Parser.Point, end: typeof Parser.Point): string {
        const startLine = start.row;
        const endLine = end.row;
        const startChar = start.column;
        const endChar = end.column;

        const lines = this.newSource.split('\n');
        const selectedLines = lines.slice(startLine, endLine + 1);
        if (selectedLines.length === 0) {
            return '';
        }
        return selectedLines.join('\n');
    }
    private createChunkFromChunks(chunks: chunkStructure[][]): chunkGroupStructure[] {
        let chunkGroups: chunkGroupStructure[] = [];
        for (let chunkGroup of chunks) {
            let totalLineCount = 0;
            let tempChunks: chunkStructure[] = [];

            for (let chunk of chunkGroup) {
                totalLineCount += chunk.endPosition.row - chunk.startPosition.row + 1;
                tempChunks.push(chunk);
                if (totalLineCount >= 200) {
                    chunkGroups.push(new chunkGroupStructure(
                        this.filePath,
                        tempChunks,
                        tempChunks[0].namedChildIndex,
                        tempChunks[tempChunks.length - 1].namedChildIndex,
                        tempChunks[0].startPosition,
                        tempChunks[tempChunks.length - 1].endPosition,
                        this.getNodeHash(this.stripAllSpaces(this.getTextFromRange(tempChunks[0].startPosition, tempChunks[tempChunks.length - 1].endPosition)
                        ))
                    ));
                    tempChunks = []; //reset the temp chunks
                    totalLineCount = 0; //reset the total line count

                }
            }
            //if any chunks are left, then lets create a chunk group for them
            if (tempChunks.length > 0) {
                chunkGroups.push(new chunkGroupStructure(
                    this.filePath,
                    tempChunks,
                    tempChunks[0].namedChildIndex,
                    tempChunks[tempChunks.length - 1].namedChildIndex,
                    tempChunks[0].startPosition,
                    tempChunks[tempChunks.length - 1].endPosition,
                    this.getNodeHash(this.stripAllSpaces(this.getTextFromRange(tempChunks[0].startPosition, tempChunks[tempChunks.length - 1].endPosition)))
                ));
            }
        }
        return chunkGroups;
    }
    public async createChunk(sourceCode: string) {
        try {
            let oldTree = this.parser.parse(sourceCode);
            this.newSource = sourceCode;
            let normalizedSource = this.normalizeText(sourceCode);
            let tree = this.parser.parse(normalizedSource);
            let chunks: chunkStructure[] = [];
            let i = -1;
            let totalLineCount = 0;

            let startChild = 0;
            let endChild = 0;
            let tempContent: string = "";
            for (let chunk of tree.rootNode.namedChildren) {
                i++;
                if (chunk.type == "empty_statement" || chunk.type == "ERROR") {
                    continue; //skip empty statements and errors
                }


                totalLineCount += chunk.endPosition.row - chunk.startPosition.row + 1;

                chunks.push(new chunkStructure(
                    this.getNodeHash(this.stripAllSpaces(chunk.text)),
                    chunk.text,
                    chunk.type,
                    chunk.startPosition,
                    chunk.startIndex,
                    chunk.endPosition,
                    chunk.endIndex,
                    this.filePath,

                    Buffer.byteLength(chunk.text, 'utf8'),
                    i
                ));
                tempContent += chunk.text;
                if (totalLineCount >= 200) {
                    //create it a chunk straight away
                    let contentHash = this.getNodeHash(this.stripAllSpaces(tempContent));
                    tempContent = ""; //reset the temp content
                    this.chunkGroup.push(new chunkGroupStructure(
                        this.filePath,
                        chunks,
                        startChild,
                        i,
                        tree.rootNode.namedChildren[startChild].startPosition,
                        tree.rootNode.namedChildren[i].endPosition,
                        contentHash

                    ));
                    totalLineCount = 0;
                    startChild = i + 1;
                    chunks = []; //reset the chunks array

                }


            }
            //if any chunks are left, then lets create a chunk group for them
            if (chunks.length > 0 && totalLineCount > 0) {
                endChild = i;
                let contentHash = this.getNodeHash(this.stripAllSpaces(tempContent));

                this.chunkGroup.push(new chunkGroupStructure(
                    this.filePath,
                    chunks,
                    startChild,
                    endChild,
                    tree.rootNode.namedChildren[startChild].startPosition,
                    tree.rootNode.namedChildren[endChild].endPosition,
                    contentHash
                ));
            }
          await this.chromaManager.addCodeChunk(this.chunkGroup, normalizedSource);
            return this.chunkGroup;

        }
        catch (err) {
            console.error("Error creating chunk for the file=>", this.filePath, "==>", err);
            return null;
        }
        //adding the chunk groups to the chroma db


    }
    public async editChunk(newSource: string) {
        try {
            let normalizedNewSource = this.normalizeText(newSource);

            this.newSource = newSource;
            let newTree = this.parser.parse(normalizedNewSource);

            let retainedChunks: chunkStructure[] = [];

            let newTreeChunks: chunkStructure[] = [];
            let i = 0;
            for (let node of newTree.rootNode.namedChildren) {
                i++;
                if (node.type == "empty_statement" || node.type == "ERROR") {
                    continue; //skip empty statements and errors
                }
                newTreeChunks.push(new chunkStructure(
                    this.getNodeHash(this.stripAllSpaces(node.text)),
                    node.text,
                    node.type,
                    node.startPosition,
                    node.startIndex,
                    node.endPosition,
                    node.endIndex,
                    this.filePath,

                    Buffer.byteLength(node.text, 'utf8'),
                    i

                ));
            }
            let dirtyChunks: Map<string, chunkGroupStructure> = new Map();
            for (let chunk of this.chunkGroup) {
                let startChunk = chunk.chunks[0];
                //finding the first chunk in the new tree, if found we will try to find all the chunks for that chunk group in sequence in the new tree
                for (let i = 0; i < newTreeChunks.length; i++) {
                    let tempRetainedChunks: chunkStructure[] = [];
                    let flag = true;
                    if (startChunk.contentHash === newTreeChunks[i].contentHash) {
                        //the first chunk of the group is found, now lets find if all the chunks of the group are present.
                        if (chunk.chunks.length == 1) {
                            //if there is only one chunk in the group, then we can just add it to the retained chunks
                            retainedChunks.push(newTreeChunks[i]);
                            break;
                        }
                        tempRetainedChunks.push(newTreeChunks[i]);
                        i++;

                        for (let j = 1; j < chunk.chunks.length; j++) {
                            if (chunk.chunks[j].contentHash === newTreeChunks[i].contentHash) {
                                //if the next chunk is also found, then we can add it to the retained chunks
                                tempRetainedChunks.push(newTreeChunks[i]);
                                i++;
                            }
                            else {
                                flag = false;
                                break;
                            }
                        }
                        if (flag) {
                            retainedChunks.push(...tempRetainedChunks);
                        }
                        else {
                            tempRetainedChunks = [];
                            dirtyChunks.set(chunk.chunkId, chunk);
                        }
                        break;
                    }
                }

            }
            // Remove chunkGroups whose value exists in dirtyChunks values
            const dirtyChunkSet = new Set(
                Array.from(dirtyChunks.values()).map(chunk => chunk.chunkId)
            );
            this.chunkGroup = this.chunkGroup.filter(ch => !dirtyChunkSet.has(ch.chunkId));
            let retainedDict = new Map<string, chunkStructure>();
            for (let chunk of retainedChunks) {
                retainedDict.set(chunk.contentHash, chunk);
            }
            let newChunks: chunkStructure[][] = [];
            let temp: chunkStructure[] = [];
            for (let n of newTreeChunks) {

                if (retainedDict.has(n.contentHash)) {
                    if (temp.length > 0) {
                        newChunks.push(temp);
                        temp = [];
                    }
                }
                else {
                    temp.push(n);
                }
            }
            if (temp.length > 0) {
                newChunks.push(temp);
            }
            let newChunkGroups = this.createChunkFromChunks(newChunks);
            //adding the new chunk groups to the existing chunk group
            this.chunkGroup.push(...newChunkGroups);
            //now we have new chunks that have to be added, and the old chunks which have to be removed.
            const dirtyChunksArray = Array.from(dirtyChunks.values());
            await this.chromaManager.updateChunks(dirtyChunksArray, newChunkGroups, normalizedNewSource);
            return true;
        }
        catch (err) {
            console.log("Error in updating the chunks==>" + "for the file=>" + this.filePath + "==>" + err);
            return false;
        }

    }
    async deleteChunk(chunkGroup: chunkGroupStructure[]) {

        return await this.chromaManager.deleteChunks(chunkGroup);
    }
}


parentPort?.on('message', async (message) => {
    try
    {
    if (message.function == "CREATE")//to create new chunks
    {
        let chunker = new chunkEditor(message.filePath, message.collectionName);
        let result = await chunker.createChunk(message.sourceCode);
        if (result == null) {
            parentPort?.postMessage({ success: false, filePath: message.filePath });
        }
        else {
            parentPort?.postMessage({ success: result, filePath: message.filePath, chunkGroup: result });
        }
    }
    else if (message.function == "UPDATE") {
        let chunker = new chunkEditor(message.filePath, message.collectionName, message.IndexMetadata);
        let result: boolean = await chunker.editChunk(message.newSource);
        parentPort?.postMessage({ success: result, filePath: message.filePath, chunkGroup: chunker.chunkGroup });

    }
    else if (message.function == "DELETE") {
        let chunker = new chunkEditor(message.filePath, message.collectionName);
        let result: boolean = await chunker.deleteChunk(message.chunkGroup);
        parentPort?.postMessage({ success: result, filePath: message.filePath });
    }
}
//adding the comments toc ehck
catch(err)
{
    console.log("Error in chunk editing worker:", err);
}


});
