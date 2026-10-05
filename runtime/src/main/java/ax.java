/*
 * Game class `ax` (the 3D camera: view transform + frustum planes used for culling), decompiled
 * from the original jar with CFR and compiled in place of the jar's copy. Changes, all marked
 * "port:":
 *   - the left/right frustum planes follow the display's aspect ratio (widescreen), otherwise
 *     the game would cull objects at the sides of a wide view;
 *   - during normal gameplay a host-controlled yaw/pitch orbit around the player is applied
 *     (right stick / mouse free-look); Mods.frame() supplies the pivot and the gameplay flag.
 */
import rdash.Host;
import com.nttdocomo.ui.util3d.Transform;
import com.nttdocomo.ui.util3d.Vector3D;

public final class ax
extends s {
    public Transform a = null;
    public long b = 0L;
    public long c = 0L;
    public long[][] d = null;
    public long[][] e = null;
    private as f = null;
    private Vector3D g = null;
    private Transform h = null;
    private long[] i = null;
    private long[] j = null;
    private Vector3D k = new Vector3D();
    private Vector3D l = new Vector3D();
    private Vector3D m = new Vector3D();

    public ax() {
        this.a = new Transform();
        this.d = new long[6][4];
        this.e = new long[6][4];
        this.h = new Transform();
        this.g = new Vector3D();
        this.f = new as();
        this.i = new long[4];
        this.j = new long[4];
    }

    // port: frustum parameters, kept so the planes can be rebuilt when the aspect ratio changes
    private int portNear;
    private int portFar;
    private int portFov;
    private float portAspect = 1.0f;
    private float portFovUsed;
    private float portDrawUsed = 1.0f;

    public final void a(int n2, int n3, int n4) {
        this.portNear = n2;
        this.portFar = n3;
        this.portFov = n4;
        this.portAspect = Host.aspect();
        this.portFovUsed = Host.fov((float)n4); // port: field of view option
        this.portDrawUsed = Host.drawDistance(); // port: draw distance option
        long l2 = 0L;
        l2 = this.portFovUsed == (float)n4
            ? (long)(Math.tan(0.017453292500000002 * (double)(n4 >> 1)) * 4096.0)
            : (long)(Math.tan(0.017453292500000002 * (double)this.portFovUsed * 0.5) * 4096.0);
        this.b = 4096L / l2 << 12;
        this.c = 4096L;
        // port: horizontal slope for the (possibly wider) view; equals this.b at 1:1
        long portB = (long)((float)this.b / this.portAspect);
        this.d[0][0] = 0L;
        this.d[0][1] = 0L;
        this.d[0][2] = 4096L;
        this.d[0][3] = -n2;
        this.d[1][0] = 0L;
        this.d[1][1] = 0L;
        this.d[1][2] = -4096L;
        this.d[1][3] = (long)((float)n3 * this.portDrawUsed); // port: far plane moved out
        this.f.a(-portB, 0L, 4096L);
        this.f.a();
        this.d[2][0] = this.f.a;
        this.d[2][1] = this.f.b;
        this.d[2][2] = this.f.c;
        this.d[2][3] = 0L;
        this.f.a(portB, 0L, 4096L);
        this.f.a();
        this.d[3][0] = this.f.a;
        this.d[3][1] = this.f.b;
        this.d[3][2] = this.f.c;
        this.d[3][3] = 0L;
        this.f.a(0L, -this.b, this.c);
        this.f.a();
        this.d[4][0] = this.f.a;
        this.d[4][1] = this.f.b;
        this.d[4][2] = this.f.c;
        this.d[4][3] = 0L;
        this.f.a(0L, this.b, this.c);
        this.f.a();
        this.d[5][0] = this.f.a;
        this.d[5][1] = this.f.b;
        this.d[5][2] = this.f.c;
        this.d[5][3] = 0L;
    }

    public final void a() {
        if (this.portFov != 0 && (Host.aspect() != this.portAspect
                || Host.fov((float)this.portFov) != this.portFovUsed
                || Host.drawDistance() != this.portDrawUsed)) {
            // port: aspect ratio, field of view or draw distance changed
            this.a(this.portNear, this.portFar, this.portFov);
        }
        int n2 = 0;
        long l2 = 0L;
        long l3 = 0L;
        long l4 = 0L;
        long l5 = 0L;
        this.h.setIdentity();
        this.h.set(this.G);
        this.h.invert();
        this.i[0] = (long)(this.h.get(3) * 4096.0f);
        this.i[1] = (long)(this.h.get(7) * 4096.0f);
        this.i[2] = (long)(this.h.get(11) * 4096.0f);
        this.i[3] = 4096L;
        this.h.set(3, 0.0f);
        this.h.set(7, 0.0f);
        this.h.set(11, 0.0f);
        this.h.transpose();
        n2 = 0;
        while (n2 < 6) {
            this.g.set((float)this.d[n2][0] / 4096.0f, (float)this.d[n2][1] / 4096.0f, (float)this.d[n2][2] / 4096.0f);
            this.h.transVector(this.g, this.g);
            l3 = (long)(this.g.getX() * 4096.0f);
            l4 = (long)(this.g.getY() * 4096.0f);
            l5 = (long)(this.g.getZ() * 4096.0f);
            l2 = this.i[0] * this.d[n2][0] + this.i[1] * this.d[n2][1] + this.i[2] * this.d[n2][2] + this.i[3] * this.d[n2][3];
            this.e[n2][0] = l3;
            this.e[n2][1] = l4;
            this.e[n2][2] = l5;
            this.e[n2][3] = l2 >>= 12;
            ++n2;
        }
    }

    public final boolean a(as as2, long l2) {
        int n2 = 0;
        long l3 = 0L;
        n2 = 0;
        while (n2 < 6) {
            this.j[0] = as2.a + (this.e[n2][0] * l2 >> 12);
            this.j[1] = as2.b + (this.e[n2][1] * l2 >> 12);
            this.j[2] = as2.c + (this.e[n2][2] * l2 >> 12);
            this.j[3] = 4096L;
            l3 = this.j[0] * this.e[n2][0] + this.j[1] * this.e[n2][1] + this.j[2] * this.e[n2][2] + this.j[3] * this.e[n2][3];
            if ((l3 >>= 12) < 0L) {
                return false;
            }
            ++n2;
        }
        return true;
    }

    // port: free-look state, refreshed every frame by Mods.frame()
    /** The mission's camera while normal gameplay is on screen, else null. */
    public static ax portCamera;
    /** Point the camera orbits: just above the player. */
    public static float portPivotX;
    public static float portPivotY;
    public static float portPivotZ;
    /** The current map (for keeping the orbiting camera inside the walls), or null. */
    public static ao portMap;
    private static bl portProbe;
    private static as portFrom;
    private static as portTo;
    /** Radius of the sphere swept from the player to the camera, as the game uses (20.12). */
    private static final long PORT_PROBE_RADIUS = 3072L;

    /**
     * port: free-look. Swings the gameplay camera around the player by the host's yaw/pitch
     * offsets, keeping the distance the game chose (it pulls the camera in near walls). The game
     * rebuilds G from the player before every call, so the offsets never accumulate.
     */
    private void portFreeLook() {
        if (portCamera != this) {
            return;
        }
        float dYaw = Host.cameraYaw();
        float dPitch = Host.cameraPitch();
        float dScale = Host.cameraDistance();
        if (dYaw == 0.0f && dPitch == 0.0f && dScale == 1.0f) {
            return;
        }
        float vx = this.G.get(3) - portPivotX;
        float vy = this.G.get(7) - portPivotY;
        float vz = this.G.get(11) - portPivotZ;
        float dist = (float)Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (dist < 0.5f) {
            return;
        }
        // heading and elevation of the line from the camera to the pivot
        double yaw = Math.atan2(-vx, -vz) + Math.toRadians(dYaw);
        double elev = Math.asin(Math.max(-1.0f, Math.min(1.0f, vy / dist))) + Math.toRadians(dPitch);
        elev = Math.max(Math.toRadians(-35.0), Math.min(Math.toRadians(80.0), elev));
        float nfx = (float)(Math.sin(yaw) * Math.cos(elev));
        float nfy = (float)(-Math.sin(elev));
        float nfz = (float)(Math.cos(yaw) * Math.cos(elev));
        // right = up x forward (the game's X column), up = forward x right
        float rx = nfz;
        float rz = -nfx;
        float rl = (float)Math.sqrt(rx * rx + rz * rz);
        if (rl < 1.0E-4f) {
            return;
        }
        rx /= rl;
        rz /= rl;
        this.G.set(0, rx);
        this.G.set(4, 0.0f);
        this.G.set(8, rz);
        this.G.set(1, nfy * rz);
        this.G.set(5, nfz * rx - nfx * rz);
        this.G.set(9, -nfy * rx);
        this.G.set(2, nfx);
        this.G.set(6, nfy);
        this.G.set(10, nfz);
        dist *= dScale; // camera distance option; the sweep below still stops it at walls
        float cx = portPivotX - nfx * dist;
        float cy = portPivotY - nfy * dist;
        float cz = portPivotZ - nfz * dist;
        if (portMap != null) {
            // sweep a small sphere from the player to the camera with the game's own map
            // collision and stop at the first wall, like the game does for its follow camera
            if (portProbe == null) {
                portProbe = new bl();
                portFrom = new as();
                portTo = new as();
            }
            portFrom.a((long)(portPivotX * 4096.0f), (long)(portPivotY * 4096.0f), (long)(portPivotZ * 4096.0f));
            portTo.a((long)(cx * 4096.0f), (long)(cy * 4096.0f), (long)(cz * 4096.0f));
            portProbe.a(portFrom);
            portProbe.a(PORT_PROBE_RADIUS);
            portProbe.b(portTo);
            long fa = portMap.f.a;
            long fb = portMap.f.b;
            long fc = portMap.f.c;
            if (portMap.a(portProbe)) {
                cx = portPivotX + (float)portMap.f.a / 4096.0f;
                cy = portPivotY + (float)portMap.f.b / 4096.0f;
                cz = portPivotZ + (float)portMap.f.c / 4096.0f;
            }
            portMap.f.a(fa, fb, fc); // leave the map's result register as the game left it
        }
        this.G.set(3, cx);
        this.G.set(7, cy);
        this.G.set(11, cz);
    }

    public final void b() {
        this.portFreeLook();
        this.a.setIdentity();
        this.k.set(this.G.get(3), this.G.get(7), this.G.get(11));
        this.l.set(this.G.get(3) + this.G.get(2), this.G.get(7) + this.G.get(6), this.G.get(11) + this.G.get(10));
        this.m.set(this.G.get(1), this.G.get(5), this.G.get(9));
        this.a.lookAt(this.k, this.l, this.m);
    }

    public final void c() {
        this.f();
        this.G.translate(this.F);
    }
}

