interface NodeChildren {
    [key: string]: Node;
}

export class Node {
    public size: number;
    public createdOn: Date;
    public createdBy: string;
    public modifiedOn: Date;
    public modifiedBy: string;
    public fileContent: string; // File content if it's a file (leaf node)
    public children: NodeChildren; // Object with path keys and Node values for directories
    public content?: string; // Optional content for files, if needed
    public title?: string;
    public address?: string;
    constructor(
        size: number,
        createdOn: Date,
        createdBy: string,
        modifiedOn: Date,
        modifiedBy: string,
        fileContent: string = '',
        title: string,
        children: NodeChildren = {}
    ) {
        this.size = size;
        this.createdOn = createdOn;
        this.createdBy = createdBy;
        this.modifiedOn = modifiedOn;
        this.modifiedBy = modifiedBy;
        this.fileContent = fileContent;
        this.children = children;
        this.title = title;
    }
}

