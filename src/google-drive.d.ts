export {};
declare global {
    interface ImportMetaEnv {
        readonly VITE_ENABLE_GOOGLE_DRIVE?: string;
        readonly VITE_GOOGLE_CLIENT_ID?: string;
        readonly VITE_GOOGLE_API_KEY?: string;
        readonly VITE_GOOGLE_APP_ID?: string;
    }
    interface ImportMeta { readonly env: ImportMetaEnv; }
    interface Window {
        google: any;
        gapi: any;
    }
}
