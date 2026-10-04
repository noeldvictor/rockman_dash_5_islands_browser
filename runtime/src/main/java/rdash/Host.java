package rdash;

import org.teavm.interop.Async;
import org.teavm.interop.AsyncCallback;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSByRef;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;

import com.nttdocomo.ui.Display;

/**
 * Bridge between the recompiled Java side and the JavaScript host (web/src/host), which is
 * published as globalThis.DOJA before the game module's main() runs.
 */
public final class Host {
    private Host() {
    }

    @JSFunctor
    public interface KeyHandler extends JSObject {
        void handle(int type, int key);
    }

    @JSFunctor
    public interface MediaHandler extends JSObject {
        void handle(int port, int event, int param);
    }

    @JSFunctor
    public interface VoidCallback extends JSObject {
        void run();
    }

    public static void init() {
        setKeyHandler(Display::dispatchKey);
        setMediaHandler(com.nttdocomo.ui.AudioPresenter::dispatch);
    }

    // ---- app -----------------------------------------------------------------------------------
    @JSBody(params = {"h"}, script = "globalThis.DOJA.input.handler = h;")
    private static native void setKeyHandler(KeyHandler h);

    @JSBody(params = {"h"}, script = "globalThis.DOJA.audio.handler = h;")
    private static native void setMediaHandler(MediaHandler h);

    @JSBody(params = {"on"}, script = "globalThis.DOJA.input.vibrate(on);")
    public static native void vibrate(boolean on);

    @JSBody(script = "return globalThis.DOJA.input.state();")
    public static native int keyState();

    @JSBody(params = {"name"}, script = "return globalThis.DOJA.app.param(name);")
    public static native String appParam(String name);

    @JSBody(script = "globalThis.DOJA.app.terminate();")
    public static native void terminate();

    @JSBody(params = {"key", "label"}, script = "globalThis.DOJA.app.softLabel(key, label);")
    public static native void softLabel(int key, String label);

    @JSBody(params = {"msg"}, script = "globalThis.DOJA.app.log(msg);")
    public static native void log(String msg);

    /**
     * True while a loading screen is on display (the host recognises them by their "please do
     * not press any buttons" line). Frame pacing is skipped then; see GameHooks.sleep.
     */
    @JSBody(script = "return performance.now() < globalThis.DOJA.loadingUntil;")
    public static native boolean isLoading();

    // ---- port features: widescreen, free-look camera, cheats ----------------------------------
    /** Display width / height (1.0 on the original square screen). */
    @JSBody(script = "return globalThis.DOJA.gfx.aspect();")
    public static native float aspect();

    /** Free-look offsets in degrees, relative to the game's own follow camera. */
    @JSBody(script = "return globalThis.DOJA.camera.yaw;")
    public static native float cameraYaw();

    @JSBody(script = "return globalThis.DOJA.camera.pitch;")
    public static native float cameraPitch();

    /** Tells the host whether the follow camera is active this frame and the player's heading. */
    @JSBody(params = {"follow", "playerYaw"}, script = "globalThis.DOJA.camera.report(follow, playerYaw);")
    public static native void cameraReport(boolean follow, float playerYaw);

    /** True once after the free-look offsets changed. */
    @JSBody(script = "return globalThis.DOJA.camera.consumeChanged();")
    public static native boolean cameraChanged();

    /** Bit set of Mods.* cheat flags; one-shot flags are cleared by the host when read. */
    @JSBody(script = "return globalThis.DOJA.cheats.flags();")
    public static native int cheatFlags();

    /** Game speed multiplier (1 = normal). */
    @JSBody(script = "return globalThis.DOJA.cheats.speed | 0;")
    public static native int cheatSpeed();

    @Async
    public static native void waitFrame();

    private static void waitFrame(AsyncCallback<Void> callback) {
        onFrame(() -> callback.complete(null));
    }

    @JSBody(params = {"cb"}, script = "globalThis.DOJA.app.onFrame(cb);")
    private static native void onFrame(VoidCallback cb);

    // ---- storage -------------------------------------------------------------------------------
    public static byte[] resource(String name) {
        return resourceExists(name) ? resource0(name) : null;
    }

    @JSBody(params = {"name"}, script = "return globalThis.DOJA.res.resource(name) != null;")
    private static native boolean resourceExists(String name);

    @JSBody(params = {"name"}, script = "return globalThis.DOJA.res.resource(name);")
    @JSByRef
    private static native byte[] resource0(String name);

    public static byte[] spRead(int seg, int pos, int len) {
        return spReadExists(seg, pos, len) ? spRead0(seg, pos, len) : null;
    }

    @JSBody(params = {"seg", "pos", "len"}, script = "return globalThis.DOJA.res.spRead(seg, pos, len) != null;")
    private static native boolean spReadExists(int seg, int pos, int len);

    @JSBody(params = {"seg", "pos", "len"}, script = "return globalThis.DOJA.res.spRead(seg, pos, len);")
    @JSByRef
    private static native byte[] spRead0(int seg, int pos, int len);

    @JSBody(params = {"seg", "pos", "data", "len"}, script = "globalThis.DOJA.res.spWrite(seg, pos, data, len);")
    public static native void spWrite(int seg, int pos, @JSByRef byte[] data, int len);

    public static byte[] sdRead(String name) {
        return sdReadExists(name) ? sdRead0(name) : null;
    }

    @JSBody(params = {"name"}, script = "return globalThis.DOJA.res.sdRead(name) != null;")
    private static native boolean sdReadExists(String name);

    @JSBody(params = {"name"}, script = "return globalThis.DOJA.res.sdRead(name);")
    @JSByRef
    private static native byte[] sdRead0(String name);

    @JSBody(params = {"name", "data", "len"}, script = "globalThis.DOJA.res.sdWrite(name, data, len);")
    public static native void sdWrite(String name, @JSByRef byte[] data, int len);

    @JSBody(params = {"data", "len"}, script = "return globalThis.DOJA.res.unzip(data, len);")
    public static native JSObject unzip(@JSByRef byte[] data, int len);

    public static byte[] zipEntry(JSObject zip, String name) {
        return zipEntryExists(zip, name) ? zipEntry0(zip, name) : null;
    }

    @JSBody(params = {"zip", "name"}, script = "return globalThis.DOJA.res.zipEntry(zip, name) != null;")
    private static native boolean zipEntryExists(JSObject zip, String name);

    @JSBody(params = {"zip", "name"}, script = "return globalThis.DOJA.res.zipEntry(zip, name);")
    @JSByRef
    private static native byte[] zipEntry0(JSObject zip, String name);

    @JSBody(params = {"url", "method", "body", "len"},
            script = "return globalThis.DOJA.net.request(url, method, len < 0 ? null : body, len);")
    private static native JSObject httpRequest0(String url, String method, @JSByRef byte[] body, int len);

    private static final byte[] EMPTY = new byte[0];

    public static JSObject httpRequest(String url, String method, byte[] body, int len) {
        return httpRequest0(url, method, body == null ? EMPTY : body, body == null ? -1 : len);
    }

    @JSBody(params = {"r"}, script = "return r.code;")
    public static native int httpCode(JSObject r);

    public static byte[] httpBody(JSObject r) {
        return httpBodyExists(r) ? httpBody0(r) : null;
    }

    @JSBody(params = {"r"}, script = "return r.body != null;")
    private static native boolean httpBodyExists(JSObject r);

    @JSBody(params = {"r"}, script = "return r.body;")
    @JSByRef
    private static native byte[] httpBody0(JSObject r);

    // ---- 2D graphics ---------------------------------------------------------------------------
    @JSBody(script = "return globalThis.DOJA.gfx.screen();")
    public static native JSObject screen();

    @JSBody(params = {"w", "h"}, script = "return globalThis.DOJA.gfx.createImage(w, h);")
    public static native JSObject createImage(int w, int h);

    @JSBody(params = {"data", "len"}, script = "return globalThis.DOJA.gfx.decodeImage(data, len);")
    public static native JSObject decodeImage(@JSByRef byte[] data, int len);

    @JSBody(params = {"img"}, script = "return img.width;")
    public static native int imageWidth(JSObject img);

    @JSBody(params = {"img"}, script = "return img.height;")
    public static native int imageHeight(JSObject img);

    @JSBody(params = {"img"}, script = "return img.graphics();")
    public static native JSObject imageGraphics(JSObject img);

    @JSBody(params = {"img"}, script = "img.dispose();")
    public static native void imageDispose(JSObject img);

    @JSBody(params = {"g"}, script = "g.lock();")
    public static native void gLock(JSObject g);

    @JSBody(params = {"g", "force"}, script = "return g.unlock(force);")
    public static native boolean gUnlock(JSObject g, boolean force);

    @JSBody(params = {"g", "rgb"}, script = "g.setColor(rgb);")
    public static native void gSetColor(JSObject g, int rgb);

    @JSBody(params = {"g", "x", "y", "w", "h"}, script = "g.setClip(x, y, w, h);")
    public static native void gSetClip(JSObject g, int x, int y, int w, int h);

    @JSBody(params = {"g"}, script = "g.clearClip();")
    public static native void gClearClip(JSObject g);

    @JSBody(params = {"g", "x", "y"}, script = "g.setOrigin(x, y);")
    public static native void gSetOrigin(JSObject g, int x, int y);

    @JSBody(params = {"g", "mode"}, script = "g.flip = mode;")
    public static native void gSetFlip(JSObject g, int mode);

    @JSBody(params = {"g", "px", "bold", "italic"}, script = "g.setFont(px, bold, italic);")
    public static native void gSetFont(JSObject g, int px, boolean bold, boolean italic);

    @JSBody(params = {"g", "x", "y", "w", "h"}, script = "g.fillRect(x, y, w, h);")
    public static native void gFillRect(JSObject g, int x, int y, int w, int h);

    @JSBody(params = {"g", "x", "y", "w", "h"}, script = "g.clearRect(x, y, w, h);")
    public static native void gClearRect(JSObject g, int x, int y, int w, int h);

    @JSBody(params = {"g", "x", "y", "w", "h"}, script = "g.drawRect(x, y, w, h);")
    public static native void gDrawRect(JSObject g, int x, int y, int w, int h);

    @JSBody(params = {"g", "x1", "y1", "x2", "y2"}, script = "g.drawLine(x1, y1, x2, y2);")
    public static native void gDrawLine(JSObject g, int x1, int y1, int x2, int y2);

    @JSBody(params = {"g", "x", "y", "w", "h", "start", "arc", "fill"}, script = "g.arc(x, y, w, h, start, arc, fill);")
    public static native void gArc(JSObject g, int x, int y, int w, int h, int start, int arc, boolean fill);

    @JSBody(params = {"g", "xs", "ys", "off", "n", "fill"}, script = "g.polygon(xs, ys, off, n, fill);")
    public static native void gPolygon(JSObject g, @JSByRef int[] xs, @JSByRef int[] ys, int off, int n, boolean fill);

    @JSBody(params = {"g", "s", "x", "y"}, script = "g.drawString(s, x, y);")
    public static native void gDrawString(JSObject g, String s, int x, int y);

    @JSBody(params = {"g", "img", "dx", "dy", "dw", "dh", "sx", "sy", "sw", "sh"},
            script = "g.drawImage(img, dx, dy, dw, dh, sx, sy, sw, sh);")
    public static native void gDrawImage(JSObject g, JSObject img, int dx, int dy, int dw, int dh,
            int sx, int sy, int sw, int sh);

    @JSBody(params = {"g", "img", "m", "sx", "sy", "w", "h"}, script = "g.drawImageAffine(img, m, sx, sy, w, h);")
    public static native void gDrawImageAffine(JSObject g, JSObject img, @JSByRef int[] m, int sx, int sy, int w, int h);

    @JSBody(params = {"g", "x", "y", "w", "h", "px", "off"}, script = "g.setRGBPixels(x, y, w, h, px, off);")
    public static native void gSetRGBPixels(JSObject g, int x, int y, int w, int h, @JSByRef int[] px, int off);

    @JSBody(params = {"g", "x", "y", "w", "h", "px", "off"}, script = "g.getRGBPixels(x, y, w, h, px, off);")
    public static native void gGetRGBPixels(JSObject g, int x, int y, int w, int h, @JSByRef int[] px, int off);

    @JSBody(params = {"g", "sx", "sy", "w", "h", "dx", "dy"}, script = "g.copyArea(sx, sy, w, h, dx, dy);")
    public static native void gCopyArea(JSObject g, int sx, int sy, int w, int h, int dx, int dy);

    // ---- 3D graphics ---------------------------------------------------------------------------
    @JSBody(params = {"data", "len"}, script = "return globalThis.DOJA.g3d.create(data, len);")
    public static native JSObject g3dCreate(@JSByRef byte[] data, int len);

    @JSBody(script = "return globalThis.DOJA.g3d.createGroup();")
    public static native JSObject g3dCreateGroup();

    @JSBody(params = {"o"}, script = "return o ? o.type : 0;")
    public static native int g3dType(JSObject o);

    @JSBody(params = {"o"}, script = "o.dispose();")
    public static native void g3dDispose(JSObject o);

    @JSBody(params = {"o", "t"}, script = "o.setTime(t);")
    public static native void g3dSetTime(JSObject o, int t);

    @JSBody(params = {"o", "name", "v"}, script = "o[name] = v;")
    public static native void g3dSetInt(JSObject o, String name, int v);

    @JSBody(params = {"o", "name", "v"}, script = "o[name] = v;")
    public static native void g3dSetFloat(JSObject o, String name, float v);

    @JSBody(params = {"o", "name", "v"}, script = "o[name] = v;")
    public static native void g3dSetBool(JSObject o, String name, boolean v);

    @JSBody(params = {"o", "name", "v"}, script = "o[name] = v;")
    public static native void g3dSetObject(JSObject o, String name, JSObject v);

    @JSBody(params = {"o", "name"}, script = "return o[name] | 0;")
    public static native int g3dGetInt(JSObject o, String name);

    @JSBody(params = {"fig", "index", "tex"}, script = "fig.setTextureAt(index, tex);")
    public static native void g3dFigureTexture(JSObject fig, int index, JSObject tex);

    @JSBody(params = {"fig", "n"}, script = "fig.setTextureCount(n);")
    public static native void g3dFigureTextureCount(JSObject fig, int n);

    @JSBody(params = {"fig", "act", "index"}, script = "fig.setAction(act, index);")
    public static native void g3dFigureAction(JSObject fig, JSObject act, int index);

    @JSBody(params = {"act", "index"}, script = "return act.getMaxFrame(index);")
    public static native int g3dMaxFrame(JSObject act, int index);

    @JSBody(params = {"grp", "el"}, script = "grp.add(el);")
    public static native void g3dGroupAdd(JSObject grp, JSObject el);

    @JSBody(params = {"grp", "index"}, script = "grp.removeAt(index);")
    public static native void g3dGroupRemove(JSObject grp, int index);

    @JSBody(params = {"grp", "m"}, script = "grp.setTransform(m);")
    public static native void g3dGroupTransform(JSObject grp, @JSByRef float[] m);

    @JSBody(params = {"g", "x", "y", "w", "h"}, script = "g.g3d.setClipRect(x, y, w, h);")
    public static native void g3dClipRect(JSObject g, int x, int y, int w, int h);

    @JSBody(params = {"g", "w", "h"}, script = "g.g3d.setParallelView(w, h);")
    public static native void g3dParallel(JSObject g, int w, int h);

    @JSBody(params = {"g", "near", "far", "angle"}, script = "g.g3d.setPerspectiveFov(near, far, angle);")
    public static native void g3dPerspectiveFov(JSObject g, float near, float far, float angle);

    @JSBody(params = {"g", "near", "far", "w", "h"}, script = "g.g3d.setPerspectiveSize(near, far, w, h);")
    public static native void g3dPerspectiveSize(JSObject g, float near, float far, int w, int h);

    public static void g3dViewTransform(JSObject g, float[] m) {
        if (m == null) {
            g3dViewIdentity(g);
        } else {
            g3dViewTransform0(g, m);
        }
    }

    @JSBody(params = {"g", "m"}, script = "g.g3d.setViewTransform(m);")
    private static native void g3dViewTransform0(JSObject g, @JSByRef float[] m);

    @JSBody(params = {"g"}, script = "g.g3d.setViewTransform(null);")
    private static native void g3dViewIdentity(JSObject g);

    @JSBody(params = {"g"}, script = "g.g3d.flush();")
    public static native void g3dFlush(JSObject g);

    public static void g3dRender(JSObject g, JSObject o, float[] m) {
        if (m == null) {
            g3dRenderIdentity(g, o);
        } else {
            g3dRender0(g, o, m);
        }
    }

    @JSBody(params = {"g", "o", "m"}, script = "g.g3d.render(o, m);")
    private static native void g3dRender0(JSObject g, JSObject o, @JSByRef float[] m);

    @JSBody(params = {"g", "o"}, script = "g.g3d.render(o, null);")
    private static native void g3dRenderIdentity(JSObject g, JSObject o);

    @JSBody(params = {"type", "param", "count"}, script = "return globalThis.DOJA.g3d.createPrimitive(type, param, count);")
    public static native JSObject g3dCreatePrimitive(int type, int param, int count);

    /** name: vertices | normals | colors | texCoords | pointSprites */
    @JSBody(params = {"p", "name", "a"}, script = "p[name] = a;")
    public static native void g3dPrimitiveArray(JSObject p, String name, @JSByRef int[] a);

    // ---- audio ---------------------------------------------------------------------------------
    @JSBody(params = {"data", "len"}, script = "return globalThis.DOJA.audio.createSound(data, len);")
    public static native JSObject soundCreate(@JSByRef byte[] data, int len);

    @JSBody(params = {"port", "snd"}, script = "globalThis.DOJA.audio.setSound(port, snd);")
    public static native void audioSetSound(int port, JSObject snd);

    @JSBody(params = {"port"}, script = "globalThis.DOJA.audio.play(port);")
    public static native void audioPlay(int port);

    @JSBody(params = {"port"}, script = "globalThis.DOJA.audio.stop(port);")
    public static native void audioStop(int port);

    @JSBody(params = {"port", "attr", "value"}, script = "globalThis.DOJA.audio.setAttribute(port, attr, value);")
    public static native void audioSetAttribute(int port, int attr, int value);
}
