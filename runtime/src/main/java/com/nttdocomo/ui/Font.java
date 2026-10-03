package com.nttdocomo.ui;

/**
 * Phone fonts are fixed-pitch bitmap fonts: full-width glyphs are size x size, half-width glyphs
 * size/2 x size. The host draws text on that grid, so metrics are computed here without measuring.
 */
public class Font {
    public static final int TYPE_DEFAULT = 0;
    public static final int TYPE_HEADING = 1;
    public static final int FACE_SYSTEM = 0x71000000;
    public static final int FACE_MONOSPACE = 0x72000000;
    public static final int FACE_PROPORTIONAL = 0x73000000;
    public static final int STYLE_PLAIN = 0x70100000;
    public static final int STYLE_BOLD = 0x70110000;
    public static final int STYLE_ITALIC = 0x70120000;
    public static final int STYLE_BOLDITALIC = 0x70130000;
    public static final int SIZE_SMALL = 0x70000100;
    public static final int SIZE_MEDIUM = 0x70000200;
    public static final int SIZE_LARGE = 0x70000300;
    public static final int SIZE_TINY = 0x70000400;

    private static final Font[] cache = new Font[64];
    private static Font defaultFont;

    final int px;
    final boolean bold;
    final boolean italic;

    private Font(int px, boolean bold, boolean italic) {
        this.px = px;
        this.bold = bold;
        this.italic = italic;
    }

    public static Font getDefaultFont() {
        if (defaultFont == null) {
            defaultFont = getFont(SIZE_MEDIUM);
        }
        return defaultFont;
    }

    public static void setDefaultFont(Font f) {
        defaultFont = f;
    }

    public static Font getFont(int type) {
        int size = (type >> 8) & 0xF;
        int style = (type >> 16) & 0xF;
        int key = (size << 2) | (style & 3);
        Font f = cache[key];
        if (f == null) {
            int px;
            switch (size) {
                case 4: px = 12; break;
                case 1: px = 16; break;
                case 3: px = 30; break;
                default: px = 24; break;
            }
            f = new Font(px, (style & 1) != 0, (style & 2) != 0);
            cache[key] = f;
        }
        return f;
    }

    public static Font getFont(int type, int size) {
        return getFont(type);
    }

    public int getAscent() {
        return px - getDescent();
    }

    public int getDescent() {
        return (px + 4) / 8;
    }

    public int getHeight() {
        return px;
    }

    public static boolean isHalfWidth(char c) {
        return c < 0x100 || (c >= 0xFF61 && c <= 0xFF9F);
    }

    public int stringWidth(String s) {
        int w = 0;
        for (int i = 0, n = s.length(); i < n; i++) {
            w += isHalfWidth(s.charAt(i)) ? px / 2 : px;
        }
        return w;
    }

    public int getBBoxWidth(String s) {
        return stringWidth(s);
    }

    public int getBBoxHeight(String s) {
        return px;
    }

    public int getLineBreak(String s, int off, int len, int width) {
        int w = 0;
        int end = Math.min(s.length(), off + len);
        for (int i = off; i < end; i++) {
            w += isHalfWidth(s.charAt(i)) ? px / 2 : px;
            if (w > width) {
                return i;
            }
        }
        return end;
    }
}
