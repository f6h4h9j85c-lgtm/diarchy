export interface WatchOptions {
    follow?: boolean;
}
export declare function runWatch(projectDir: string, options: WatchOptions): Promise<number>;
