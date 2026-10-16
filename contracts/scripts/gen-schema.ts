import { writeFileSync } from "node:fs";
import { disposalEventJsonSchema } from "./json-schema.js";

const target = new URL("../disposal-event.schema.json", import.meta.url);
writeFileSync(target, JSON.stringify(disposalEventJsonSchema(), null, 2) + "\n");
console.log(`wrote ${target.pathname}`);
