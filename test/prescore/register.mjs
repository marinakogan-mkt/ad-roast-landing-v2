// node --import ./test/prescore/register.mjs --test test/prescore/
// The repo has no node_modules on a dev machine: stub the one package the scorer imports at load.
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
