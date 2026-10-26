export interface ReplyCliOptions {
    decision?: string;
    /** `--task`, repeatable: the tasks a ruling on an open plan opens EXECUTE with. */
    task?: string[];
    budget: string[];
    body?: string;
    json?: boolean;
}
export declare function runReply(projectDir: string, text: string, options: ReplyCliOptions): Promise<number>;
export interface StopCliOptions {
    reason?: string;
    json?: boolean;
}
export declare function runStop(projectDir: string, options: StopCliOptions): Promise<number>;
