import path from "node:path";
import { tests } from "@iobroker/testing";

tests.packageFiles(path.join(__dirname, "..", ".."));
