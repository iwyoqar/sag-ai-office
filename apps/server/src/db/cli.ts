import { config } from "../config.js";
import { Db } from "./db.js";
import { seed, writeInitialAdminPassword } from "./seed.js";

const cmd = process.argv[2];
const db = new Db(config.databasePath);
const applied = db.migrate();
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Migrations up to date");
if (cmd === "seed") {
  const r = await seed(db, { adminPassword: config.adminPassword });
  if (!r.seeded) console.log("Already seeded");
  else if (r.admin?.generated) {
    const file = writeInitialAdminPassword(config.databasePath, r.admin.password);
    console.log(`Admin login: admin. Generated password written to ${file} — read it, sign in, change it, delete the file.`);
  }
  else console.log("Seeded. Admin password taken from ADMIN_PASSWORD.");
}
db.close();
