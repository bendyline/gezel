declare module 'virtual:gezel-portable-sdk' {
  export const sdkModuleSource: string;
  export const checksModuleSource: string;
}
declare module 'virtual:gezel-portable-sdk-types' {
  export const sdkTypes: import('@bendyline/gezel').SdkTypesResponse;
}
declare module 'virtual:gezel-portable-scripts' {
  export const scripts: Readonly<
    Record<string, import('@bendyline/gezel-script-runtime').PortableScriptDefinition>
  >;
}
