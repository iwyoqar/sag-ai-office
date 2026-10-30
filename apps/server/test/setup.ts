// Runs before every test file. Password hashing is deliberately slow (scrypt); with the production work factor
// a test that creates and signs in a handful of people spends most of its time hashing, and under parallel
// load that alone pushed tests past their timeout. Tests check the auth logic, not the work factor.
import { setHashCostForTests } from "../src/lib/passwords.js";

setHashCostForTests({ N: 1024, r: 8, p: 1 });
