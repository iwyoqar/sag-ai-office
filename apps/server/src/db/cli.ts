import { config } from "../config.js";
import { Db } from "./db.js";
import { seed } from "./seed.js";

const cmd = process.argv[2];
const db = new Db(config.databasePath);
const applied = db.migrate();
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Migrations up to date");
if (cmd === "seed") {
  const r = await seed(db, { adminPassword: config.adminPassword });
  if (!r.seeded) console.log("Already seeded");
  else if (r.admin?.generated) console.log(`Admin login: admin  password: ${r.admin.password}  (shown only once)`);
  else console.log("Seeded. Admin password taken from ADMIN_PASSWORD.");
}
db.close();
