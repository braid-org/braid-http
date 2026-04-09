import { IncomingMessage, ServerResponse } from 'http';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export declare function http_server(handler: RequestHandler): RequestHandler;
export declare function http_server(req: IncomingMessage, res: ServerResponse, next?: () => void): void;

export declare function free_cors(res: ServerResponse): void;

export declare function fetch(url: string, params?: Record<string, any>): Promise<Response>;

export declare function sync_resource(url: string, options?: {
    signal?: AbortSignal;
    on_update?: (update: any) => void;
    on_warning?: (msg: string) => void;
    on_error?: (err: Error) => void;
    parents?: string[] | (() => string[] | null | undefined);
    headers?: Record<string, string>;
    heartbeats?: number;
    put_timeout?: number;
}): {
    put(update: Record<string, any>): Promise<Response>;
};

export declare function http_client(httpModule: any): any;
