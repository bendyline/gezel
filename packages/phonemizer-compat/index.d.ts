/** See index.mjs: Gezel replaces eSpeak NG with its own phoneme frontend. */
export declare const gezelPhonemizerCompatibilityStub: true;
export declare function phonemize(text?: string, language?: string): Promise<string[]>;
declare const _default: { phonemize: typeof phonemize };
export default _default;
