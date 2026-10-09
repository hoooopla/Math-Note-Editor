declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;

export const buildInfo = {
    version: __APP_VERSION__,
    commit: __BUILD_COMMIT__,
    builtAt: __BUILD_TIME__
};
