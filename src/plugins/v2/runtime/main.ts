import { connectParentPortRuntime, type ParentPortLike } from "./runtime";

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) {
  void connectParentPortRuntime(parentPort, { fallbackMain: process.argv[2] });
}
