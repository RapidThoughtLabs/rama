import { FONT_SCALES, getTheme, sortThemes, useTheme, type FontScale, type ReadingFont } from "@rama/ui";
import { useThemesData } from "../data/ThemesProvider";
import { Swatch } from "../shell/ThemePopover";
import { Card, MiniSeg, PaneHead, Row, Section } from "./parts";

/* The same controls as the seal's theme popover (shell/ThemePopover.tsx), with room to breathe. */

const READING: { id: ReadingFont; label: string }[] = [
  { id: "serif", label: "Serif" },
  { id: "sans", label: "Sans" },
];

export function AppearancePane() {
  const { themeId, themes, fontScale, reading, setThemeId, setFontScale, setReading } = useTheme();
  const { errors } = useThemesData();
  const active = getTheme(themeId, themes);
  const sizes = FONT_SCALES.map((s) => ({ id: String(s.value), label: s.label }));

  return (
    <>
      <PaneHead title="Appearance" sub="One theme for all of Rama, in every window. You can also switch it from the seal in the top corner." />
      <div className="r-set-body">
        <Section title={`Theme · ${active.label}, ${active.mode === "light" ? "light" : "dark"}`}>
          <Card>
            <div className="r-swatches" role="radiogroup" aria-label="Theme">
              {sortThemes(themes).map((t) => (
                <Swatch key={t.id} theme={t} checked={t.id === active.id} onSelect={() => setThemeId(t.id)} />
              ))}
            </div>
          </Card>
          {errors.length > 0 && (
            <div className="r-set-note">
              {errors.map((e) => (
                <div key={e.file} className="r-set-error">
                  {e.file}: {e.message}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Reading">
          <Card>
            <Row title="Text size" hint="Scales text everywhere, the terminal included.">
              <MiniSeg label="Text size" options={sizes} value={String(fontScale)} onChange={(v) => setFontScale(Number(v) as FontScale)} />
            </Row>
            <Row title="Reply font" hint="How the model's answers are set.">
              <MiniSeg label="Reply font" options={READING} value={reading} onChange={setReading} />
            </Row>
          </Card>
        </Section>
      </div>
    </>
  );
}
