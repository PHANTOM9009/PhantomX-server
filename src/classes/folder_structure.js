"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Node = void 0;
var Node = /** @class */ (function () {
    function Node(size, createdOn, createdBy, modifiedOn, modifiedBy, fileContent, title, children) {
        if (fileContent === void 0) { fileContent = ''; }
        if (children === void 0) { children = {}; }
        this.size = size;
        this.createdOn = createdOn;
        this.createdBy = createdBy;
        this.modifiedOn = modifiedOn;
        this.modifiedBy = modifiedBy;
        this.fileContent = fileContent;
        this.children = children;
        this.title = title;
    }
    return Node;
}());
exports.Node = Node;
