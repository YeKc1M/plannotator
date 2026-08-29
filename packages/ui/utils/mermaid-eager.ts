/**
 * Eager Mermaid registration: imports the runtime statically, initializes it
 * at module evaluation (exactly where the old module-scope
 * `mermaid.initialize` ran) and fills the slot in `./mermaid`.
 *
 * `packages/editor/App.tsx` imports this module for its side effect, by
 * policy: Plannotator's own surfaces keep Mermaid in their entry chunk so it
 * can never fail separately from the app (on the share portal this is what
 * keeps `mermaid.core` out of a lazy chunk). The review editor does not import
 * it because it never renders a Mermaid block; adding the runtime there would
 * grow that bundle. A host that wants the same import adds:
 *
 *   import '@plannotator/ui/utils/mermaid-eager';
 *
 * A host that does not import it gets the lazy path in `./mermaid`.
 *
 * The source tag passed below doubles as a build marker: the literal only
 * reaches a bundle when this module is evaluated in it, so a dropped or
 * tree-shaken side-effect import is caught by the built-HTML check in
 * tests/entry-assets.test.ts (the runtime itself stays inlined in a
 * single-file build through the loader's import(), so a Mermaid diagram id
 * cannot prove registration).
 */
import mermaid from 'mermaid';
import { MERMAID_CONFIG, setMermaidRuntime } from './mermaid';

mermaid.initialize(MERMAID_CONFIG);
setMermaidRuntime(mermaid, 'plannotator-mermaid-eager');
