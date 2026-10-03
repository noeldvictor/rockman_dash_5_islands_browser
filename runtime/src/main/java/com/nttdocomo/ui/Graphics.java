package com.nttdocomo.ui;

import org.teavm.jso.JSObject;

import com.nttdocomo.ui.graphics3d.DrawableObject3D;
import com.nttdocomo.ui.graphics3d.Fog;
import com.nttdocomo.ui.graphics3d.Graphics3D;
import com.nttdocomo.ui.graphics3d.Light;
import com.nttdocomo.ui.util3d.Transform;

import rdash.Host;

/** 2D drawing plus the DoJa 5 3D interface; all rasterisation is done by the JS host (three.js). */
public class Graphics implements Graphics3D {
    public static final int BLACK = 0;
    public static final int BLUE = 1;
    public static final int LIME = 2;
    public static final int AQUA = 3;
    public static final int RED = 4;
    public static final int FUCHSIA = 5;
    public static final int YELLOW = 6;
    public static final int WHITE = 7;
    public static final int GRAY = 8;
    public static final int NAVY = 9;
    public static final int GREEN = 10;
    public static final int TEAL = 11;
    public static final int MAROON = 12;
    public static final int PURPLE = 13;
    public static final int OLIVE = 14;
    public static final int SILVER = 15;
    public static final int FLIP_NONE = 0;
    public static final int FLIP_HORIZONTAL = 1;
    public static final int FLIP_VERTICAL = 2;
    public static final int FLIP_ROTATE = 3;
    public static final int FLIP_ROTATE_LEFT = 4;
    public static final int FLIP_ROTATE_RIGHT = 5;
    public static final int FLIP_ROTATE_RIGHT_HORIZONTAL = 6;
    public static final int FLIP_ROTATE_RIGHT_VERTICAL = 7;

    private static final int[] NAMED = {
        0x000000, 0x0000FF, 0x00FF00, 0x00FFFF, 0xFF0000, 0xFF00FF, 0xFFFF00, 0xFFFFFF,
        0x808080, 0x000080, 0x008000, 0x008080, 0x800000, 0x800080, 0x808000, 0xC0C0C0,
    };

    private final JSObject js;

    protected Graphics() {
        this(null);
    }

    Graphics(JSObject js) {
        this.js = js;
        setFont(Font.getDefaultFont());
    }

    public Graphics copy() {
        return this;
    }

    public void dispose() {
    }

    public static int getColorOfName(int name) {
        return 0xFF000000 | NAMED[name & 15];
    }

    public static int getColorOfRGB(int r, int g, int b) {
        return 0xFF000000 | (r & 255) << 16 | (g & 255) << 8 | (b & 255);
    }

    public static int getColorOfRGB(int r, int g, int b, int a) {
        return (a & 255) << 24 | (r & 255) << 16 | (g & 255) << 8 | (b & 255);
    }

    public void lock() {
        Host.gLock(js);
    }

    public void unlock(boolean forced) {
        // wait for the display's next frame, except on loading screens
        if (Host.gUnlock(js, forced) && !Host.isLoading()) {
            Host.waitFrame();
        }
    }

    public void setColor(int color) {
        Host.gSetColor(js, color);
    }

    public void setFont(Font font) {
        Host.gSetFont(js, font.px, font.bold, font.italic);
    }

    public void setOrigin(int x, int y) {
        Host.gSetOrigin(js, x, y);
    }

    public void setClip(int x, int y, int w, int h) {
        Host.gSetClip(js, x, y, w, h);
    }

    public void clipRect(int x, int y, int w, int h) {
        Host.gSetClip(js, x, y, w, h);
    }

    public void clearClip() {
        Host.gClearClip(js);
    }

    public void setFlipMode(int mode) {
        Host.gSetFlip(js, mode);
    }

    public void setPictoColorEnabled(boolean enabled) {
    }

    public void clearRect(int x, int y, int w, int h) {
        Host.gClearRect(js, x, y, w, h);
    }

    public void fillRect(int x, int y, int w, int h) {
        Host.gFillRect(js, x, y, w, h);
    }

    public void drawRect(int x, int y, int w, int h) {
        Host.gDrawRect(js, x, y, w, h);
    }

    public void drawLine(int x1, int y1, int x2, int y2) {
        Host.gDrawLine(js, x1, y1, x2, y2);
    }

    public void drawArc(int x, int y, int w, int h, int start, int arc) {
        Host.gArc(js, x, y, w, h, start, arc, false);
    }

    public void fillArc(int x, int y, int w, int h, int start, int arc) {
        Host.gArc(js, x, y, w, h, start, arc, true);
    }

    public void drawPolyline(int[] xs, int[] ys, int n) {
        Host.gPolygon(js, xs, ys, 0, n, false);
    }

    public void drawPolyline(int[] xs, int[] ys, int off, int n) {
        Host.gPolygon(js, xs, ys, off, n, false);
    }

    public void fillPolygon(int[] xs, int[] ys, int n) {
        Host.gPolygon(js, xs, ys, 0, n, true);
    }

    public void fillPolygon(int[] xs, int[] ys, int off, int n) {
        Host.gPolygon(js, xs, ys, off, n, true);
    }

    public void drawString(String s, int x, int y) {
        if (s != null && s.length() > 0) {
            Host.gDrawString(js, s, x, y);
        }
    }

    public void drawChars(char[] data, int x, int y, int off, int len) {
        drawString(new String(data, off, len), x, y);
    }

    public void drawImage(Image img, int x, int y) {
        if (img != null && img.js != null) {
            Host.gDrawImage(js, img.js, x, y, -1, -1, 0, 0, -1, -1);
        }
    }

    public void drawImage(Image img, int dx, int dy, int sx, int sy, int w, int h) {
        if (img != null && img.js != null) {
            Host.gDrawImage(js, img.js, dx, dy, w, h, sx, sy, w, h);
        }
    }

    public void drawScaledImage(Image img, int dx, int dy, int dw, int dh, int sx, int sy, int sw, int sh) {
        if (img != null && img.js != null) {
            Host.gDrawImage(js, img.js, dx, dy, dw, dh, sx, sy, sw, sh);
        }
    }

    public void drawImage(Image img, int[] matrix) {
        if (img != null && img.js != null) {
            Host.gDrawImageAffine(js, img.js, matrix, 0, 0, -1, -1);
        }
    }

    public void drawImage(Image img, int[] matrix, int sx, int sy, int w, int h) {
        if (img != null && img.js != null) {
            Host.gDrawImageAffine(js, img.js, matrix, sx, sy, w, h);
        }
    }

    public void copyArea(int x, int y, int w, int h, int dx, int dy) {
        Host.gCopyArea(js, x, y, w, h, dx, dy);
    }

    public void setRGBPixels(int x, int y, int w, int h, int[] pixels, int off) {
        Host.gSetRGBPixels(js, x, y, w, h, pixels, off);
    }

    public void setPixels(int x, int y, int w, int h, int[] pixels, int off) {
        Host.gSetRGBPixels(js, x, y, w, h, pixels, off);
    }

    public int[] getRGBPixels(int x, int y, int w, int h, int[] pixels, int off) {
        if (pixels == null) {
            pixels = new int[off + w * h];
        }
        Host.gGetRGBPixels(js, x, y, w, h, pixels, off);
        return pixels;
    }

    public int[] getPixels(int x, int y, int w, int h, int[] pixels, int off) {
        return getRGBPixels(x, y, w, h, pixels, off);
    }

    public int getRGBPixel(int x, int y) {
        return getRGBPixels(x, y, 1, 1, null, 0)[0];
    }

    public int getPixel(int x, int y) {
        return getRGBPixel(x, y);
    }

    public void setRGBPixel(int x, int y, int color) {
        setRGBPixels(x, y, 1, 1, new int[] {color}, 0);
    }

    public void setPixel(int x, int y, int color) {
        setRGBPixel(x, y, color);
    }

    // ---- Graphics3D ----------------------------------------------------------------------------
    public void setClipRectFor3D(int x, int y, int w, int h) {
        Host.g3dClipRect(js, x, y, w, h);
    }

    public void setParallelView(int w, int h) {
        Host.g3dParallel(js, w, h);
    }

    public void setPerspectiveView(float near, float far, int w, int h) {
        Host.g3dPerspectiveSize(js, near, far, w, h);
    }

    public void setPerspectiveView(float near, float far, float angle) {
        Host.g3dPerspectiveFov(js, near, far, angle);
    }

    public void flushBuffer() {
        Host.g3dFlush(js);
    }

    public void setTransform(Transform t) {
        Host.g3dViewTransform(js, t == null ? null : t.m);
    }

    public void addLight(Light light, Transform t) {
    }

    public void resetLights() {
    }

    public void setFog(Fog fog) {
    }

    public void renderObject3D(DrawableObject3D obj, Transform t) {
        if (obj != null && obj.js != null) {
            Host.g3dRender(js, obj.js, t == null ? null : t.m);
        }
    }
}
