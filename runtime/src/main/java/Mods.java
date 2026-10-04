import com.nttdocomo.ui.Display;
import com.nttdocomo.ui.Frame;

import rdash.Host;

/**
 * Cheats and free-look camera support, run once per game frame. Lives in the default package,
 * like the game's classes, so it can reach their fields (all made public at build time by
 * tools/patch_jar.py): `ad` is the game canvas, `ad.i` (class am) the save data with
 * m/o = max/current life, n/p = max/current special-weapon energy, q = zenny, and `ad.p`
 * (class z) the frame limiter whose `b` is the target frame rate.
 */
public final class Mods {
    public static final int INFINITE_LIFE = 1;
    public static final int INFINITE_ENERGY = 2;
    public static final int MAX_ZENNY = 4;
    public static final int REFILL = 8;

    private static final int NORMAL_FPS = 15;
    private static boolean speedChanged;

    private Mods() {
    }

    /** Index of the mission state (class bp) in the game's state machine (ad.u; u.f = current state). */
    private static final int STATE_MISSION = 2;
    /** Height above the player's feet of the point the follow camera looks at. */
    private static final float PIVOT_HEIGHT = 4.14f;

    /**
     * Free-look: tell the camera override (ax) whether normal gameplay is on screen and where the
     * player is, and report the player's heading to the host for camera-relative steering.
     */
    private static void camera(ad game) {
        bp mission = game.w;
        boolean gameplay = game.u != null && game.u.f == STATE_MISSION && mission != null
                && mission.d != null && mission.d.a != null && mission.a != null && mission.e != null
                && !(mission.e.e || mission.e.f || mission.d.a.D || mission.f || mission.g || mission.h);
        if (!gameplay) {
            ax.portCamera = null;
            ax.portMap = null;
            return;
        }
        av player = mission.d.a;
        ax.portCamera = mission.a;
        ax.portMap = mission.d.b;
        ax.portPivotX = player.G.get(3);
        ax.portPivotY = player.G.get(7) + PIVOT_HEIGHT;
        ax.portPivotZ = player.G.get(11);
        float yaw = (float) Math.toDegrees(Math.atan2(player.G.get(2), player.G.get(10)));
        Host.cameraReport(true, yaw);
        if (Host.cameraChanged()) {
            player.o = true; // the game only rebuilds its camera when the player has moved
        }
    }

    public static void frame() {
        Frame frame = Display.getCurrent();
        if (!(frame instanceof ad)) {
            return;
        }
        ad game = (ad) frame;
        camera(game);
        int flags = Host.cheatFlags();
        am save = game.i;
        if (save != null) {
            boolean refill = (flags & REFILL) != 0;
            if (((flags & INFINITE_LIFE) != 0 || refill) && save.o > 0 && save.o < save.m) {
                save.o = save.m;
            }
            if (((flags & INFINITE_ENERGY) != 0 || refill) && save.p < save.n) {
                save.p = save.n;
            }
            if ((flags & MAX_ZENNY) != 0) {
                save.q = 99999999;
            }
        }
        // game speed: the game logic advances one step per frame, so raising the frame limiter's
        // target makes everything faster
        int speed = Host.cheatSpeed();
        if (game.p != null) {
            if (speed > 1 && game.p.b > 0) {
                game.p.b = NORMAL_FPS * speed;
                speedChanged = true;
            } else if (speedChanged) {
                game.p.b = NORMAL_FPS;
                speedChanged = false;
            }
        }
    }
}
