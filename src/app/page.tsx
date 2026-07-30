import { Bridge } from "@/components/bridge/Bridge";
// OPTIONS DIVISION — the single insertion point for the engine options surface.
// Mounted as a SIBLING of <Bridge /> rather than inside it, so Bridge.tsx is not
// modified at all: the panel is self-contained fixed chrome (its own edge tab,
// scrim and sheet in the deck's empty right gutter) and touches none of the
// deck's layout. See src/components/bridge/OptionsPanel.tsx.
import { OptionsPanel } from "@/components/bridge/OptionsPanel";

export default function Home() {
  return (
    <>
      <Bridge />
      <OptionsPanel />
    </>
  );
}
