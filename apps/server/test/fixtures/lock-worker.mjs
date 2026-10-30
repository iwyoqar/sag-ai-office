// Worker threads do not inherit the test runner's TypeScript loader: register tsx here, then run the real worker.
import { register } from "tsx/esm/api";
register();
await import("./lock-worker.ts");
