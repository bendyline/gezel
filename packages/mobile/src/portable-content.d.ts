declare module 'virtual:gezel-portable-content' {
  const content: import('@bendyline/gezel/runtime').PortableContent;
  export default content;
}
declare module 'virtual:gezel-portable-project-types' {
  const projectTypes: readonly import('@bendyline/gezel/runtime').PortableProjectType[];
  export default projectTypes;
}
declare module 'virtual:gezel-page-library-lines' {
  /** The page library lines this build ships, without their files. */
  const lines: import('@bendyline/gezel/pages').PageLibraryLine[];
  export default lines;
}

declare module 'virtual:gezel-page-libraries' {
  /** The page libraries this build ships, and their files by `library@version/path`. */
  const libraries: {
    lines: import('@bendyline/gezel/pages').PageLibraryLine[];
    files: Record<string, string>;
    /** Module files, already compiled for the linker. */
    modules: Record<string, { code: string; imports: string[] }>;
  };
  export default libraries;
}
