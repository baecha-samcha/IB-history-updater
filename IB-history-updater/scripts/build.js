import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

for (const file of ["server.js", "app.js", "index.html", "styles.css", "db/schema.sql", "scripts/migrate.js", "tests/integration.js"]) {
  accessSync(file, constants.R_OK);
}
execFileSync(process.execPath, ["--check", "server.js"], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", "app.js"], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", "scripts/migrate.js"], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", "tests/integration.js"], { stdio: "inherit" });
console.log("Build validation completed.");
