import { IncomingMessage, ServerResponse } from 'http';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export declare function http_server(handler: RequestHandler): RequestHandler;
export declare function http_server(req: IncomingMessage, res: ServerResponse, next?: () => void): void;

export declare function free_cors(res: ServerResponse): void;

export declare function fetch(url: string, params?: Record<string, any>): Promise<Response>;

export declare function reliable_update_channel(url: string, options?: {
    on_update?: (update: any) => void;
    on_status?: (status: { online: boolean; outstanding_puts: number }) => void;
    on_warning?: (msg: string) => void;
    on_error?: (err: Error) => void;
    reconnect_from_parents?: string[] | (() => string[] | null | undefined);
    get_headers?: Record<string, string>;
    put_headers?: Record<string, string>;
    timeout?: number;
}): {
    put(update: Record<string, any>): Promise<Response>;
    close(): void;
};

export declare function http_client(httpModule: any): any;
