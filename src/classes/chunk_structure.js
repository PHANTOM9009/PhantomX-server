"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkGroupStructure = exports.chunkStructure = void 0;
//this file will have the structure  of a single chunk
var Parser = require('tree-sitter');
var uuid_1 = require("uuid");
var chunkStructure //for the individual chunk
 = /** @class */ (function () {
    function chunkStructure(contentHash, content, type, startPosition, startIndex, endPosition, endIndex, filePath, chunkSize, namedChildIndex) {
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
    return chunkStructure;
}());
exports.chunkStructure = chunkStructure;
var chunkGroupStructure //for the group of chunks
 = /** @class */ (function () {
    function chunkGroupStructure(filePath, chunks, chunkStartNumber, chunkEndNumber, chunkStartPosition, chunkEndPosition, contentHash) {
        this.filePath = filePath;
        this.chunks = chunks;
        this.chunkStartIndex = chunkStartNumber;
        this.contentHash = contentHash;
        this.chunkEndIndex = chunkEndNumber;
        this.chunkId = (0, uuid_1.v4)();
        this.chunkStartPosition = chunkStartPosition;
        this.chunkEndPosition = chunkEndPosition;
    }
    return chunkGroupStructure;
}());
exports.chunkGroupStructure = chunkGroupStructure;
