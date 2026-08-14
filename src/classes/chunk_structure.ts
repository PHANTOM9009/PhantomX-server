//this file will have the structure  of a single chunk
const Parser = require('tree-sitter');

import { v4 as uuidv4 } from 'uuid';

export class chunkStructure //for the individual chunk
{
    public contentHash:string; //this will be considered as the unique identifier for the chunk
    public content:string;
    public type:string;//this is the type of the node which is a chunk eg. a class, function etc.
    public startPosition: typeof Parser.Point;
    public startIndex: number;
    public endPosition: typeof Parser.Point;
    public endIndex: number;
    public filePath: string;
    public chunkSize: number; //this will be the size of the chunk in bytes
    public namedChildIndex:number; //this will be the index of the named child in the tree

    constructor(contentHash: string,content:string, type: string, startPosition: typeof Parser.Point, startIndex: number, endPosition: typeof Parser.Point, endIndex: number, filePath: string, chunkSize: number, namedChildIndex: number) {
        this.contentHash = contentHash;
        this.content = content;
        this.type = type;
        this.startPosition = startPosition;
        this.startIndex = startIndex;
        this.endPosition = endPosition;
        this.endIndex = endIndex;
        this.filePath = filePath;
        this.chunkSize = chunkSize;
        this.namedChildIndex = namedChildIndex;
    }
}

export class chunkGroupStructure //for the group of chunks
{
    public chunkId:string;
    public filePath: string; //this is the path of the file which contains the chunks
    public chunks: chunkStructure[]; //this is the array of chunks in the file
    public chunkStartIndex:number;//number of the first namedChild from where the tree starts
    public chunkEndIndex:number;//number of the last namedChild from where the tree ends
    public chunkStartPosition:typeof Parser.Point;
    public chunkEndPosition: typeof Parser.Point;
    public contentHash:string;

    constructor(filePath: string, chunks: chunkStructure[], chunkStartNumber: number, chunkEndNumber: number, chunkStartPosition: typeof Parser.Point, 
        chunkEndPosition:  typeof Parser.Point,contentHash:string) {
        this.filePath = filePath;
        this.chunks = chunks;
        this.chunkStartIndex = chunkStartNumber;
        this.contentHash = contentHash;
        this.chunkEndIndex = chunkEndNumber;
        this.chunkId = uuidv4();
        this.chunkStartPosition = chunkStartPosition;
        this.chunkEndPosition = chunkEndPosition;
    }
}