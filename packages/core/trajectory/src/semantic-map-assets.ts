/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = "bb92850942f4a5b5";
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
    "index.html": Object.freeze({ bytes: 186280, sha256: "493a366dec9e8b408ee47f42c03408444ce5030076a0d4bb163eb0b1fda809c2" }),
    "semantic-map.html": Object.freeze({ bytes: 772188, sha256: "d44c1ada579e021a304593c4504c0116619b7b8b0ad47568414ecc8f5038c9f0" }),
    "semantic-map.js": Object.freeze({ bytes: 38346, sha256: "420d988334bad7295cf2ed81063eb580663e7a3f5cbb2600dbe13294f3207a0a" }),
    "semantic-map.css": Object.freeze({ bytes: 13136, sha256: "0c327edb0c79578dc46ac55100f7eefd09a905862f1c85e2a0fe016368fb19eb" })
  })
});
