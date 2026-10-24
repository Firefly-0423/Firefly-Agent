declare module "*.svg?url" {
  const resourceUrl: string;
  export default resourceUrl;
}
declare module "*.svg" {
  const resourceUrl: string;
  export default resourceUrl;
}
declare module "*.jpg" {
  const resourceUrl: string;
  export default resourceUrl;
}
declare module "*.png" {
  const resourceUrl: string;
  export default resourceUrl;
}
declare module "*.mp3" {
  const resourceUrl: string;
  export default resourceUrl;
}
declare module "*.md?raw" {
  const markdownSource: string;
  export default markdownSource;
}
