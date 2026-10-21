# Fallback fonts

When a PDF's embedded font is a subset that lacks a character you type, the
editor and the exported PDF both draw that line with a fallback font: the same
font installed on the computer if there is one, otherwise the closest installed
font, otherwise one of these (metrics-compatible with the fonts in brackets):

- Liberation Sans (Arial, Helvetica), Liberation Serif (Times New Roman),
  Liberation Mono (Courier New): https://github.com/liberationfonts/liberation-fonts 2.1.5
- Carlito (Calibri), Caladea (Cambria): https://github.com/google/fonts
- Docuflex Modern Roman, Sans and Mono (Computer Modern, the LaTeX default):
  Latin Modern 2.004 by the GUST e-foundry, https://ctan.org/pkg/lm

Liberation, Carlito and Caladea are under the SIL Open Font License 1.1. The
Docuflex Modern fonts are under the GUST Font License (LPPL 1.3c, see
GUST-FONT-LICENSE.txt); MANIFEST-DocuflexModern.txt lists how they were made.
The same files are served to the editor as WOFF2 from `public/fonts/fallback/`.
