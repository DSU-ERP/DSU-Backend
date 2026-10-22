import { d as PGliteInterface } from '../pglite-C1eAkqkG.cjs';

declare const isn: {
    name: string;
    setup: (_pg: PGliteInterface, _emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { isn };
