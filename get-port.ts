import { createHash } from "node:crypto";

const name = "Anima";
const hashHex = createHash("sha256").update(name).digest("hex");
const port = parseInt(hashHex.substring(0, 4), 16);
console.log({ name, hashHex, port });
