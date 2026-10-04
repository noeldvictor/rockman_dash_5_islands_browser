import com.nttdocomo.ui.Display;
import com.nttdocomo.ui.Frame;
import com.nttdocomo.ui.Graphics;
import com.nttdocomo.ui.util3d.FastMath;

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
        // direct stick movement: face where the stick points at once (the game itself turns the
        // player 8 degrees per frame, with the same two calls)
        float want = Host.analogHeading();
        if (want == want) {
            float turn = want - yaw;
            turn -= 360.0f * (float) Math.floor((turn + 180.0f) / 360.0f);
            if (Math.abs(turn) > 0.5f) {
                player.f(0.0f, turn, 0.0f);
                player.g(0.0f, turn, 0.0f);
                player.o = true;
                yaw += turn;
            }
        }
        Host.cameraReport(true, yaw);
        if (Host.cameraChanged()) {
            player.o = true; // the game only rebuilds its camera when the player has moved
        }
    }

    /**
     * port: replaces bh.a(Graphics, bn), the mission HUD; its one call (in bp) is redirected here
     * by tools/patch_jar.py. The drawing is the original's. In widescreen the life gauge moves to
     * the left screen edge and the special-weapon gauge to the right one; the boss gauge stays
     * centred.
     */
    public static void hud(bh world, Graphics g, bn sprites) {
        am save = world.e;
        int inset = Host.hudBegin();
        try {
            g.setOrigin(-inset, 0);
            sprites.a(g, 37, 12, 190 - (save.m + 15) + 11);
            sprites.a(g, 38, 13, 190 - save.m + 11, 8, save.m - 11);
            sprites.a(g, 39, 5, 190);
            g.setColor(Graphics.getColorOfRGB(255, 192, 37));
            g.fillRect(16, 196 - save.o, 2, save.o);
            g.setOrigin(inset, 0);
            sprites.a(g, 46, 222, 210 - (save.n >> 1) - 9);
            sprites.a(g, 47, 225, 210 - (save.n >> 1), 6, save.n >> 1);
            sprites.a(g, 48, 221, 210);
            if (save.p >= 0) {
                g.setColor(Graphics.getColorOfRGB(45, 113, 239));
                g.fillRect(227, 210 - (save.p >> 1), 2, save.p >> 1);
            }
            if (world.r) {
                g.setOrigin(-inset, 0);
                sprites.b(g, 12, 221);
            }
            g.setOrigin(0, 0);
            ag first = world.a(0);
            if (first.E().ar >= 30) {
                sprites.a(g, 49, 58, 5);
                g.setColor(Graphics.getColorOfRGB(255, 96, 0));
                long life = first.i().k;
                long max = first.E().av;
                if (life == max) {
                    g.fillRect(66, 12, 150, 2);
                } else {
                    int w = (int) ((float) life / ((float) max / 150.0f));
                    g.fillRect(216 - w, 12, w, 2);
                }
            }
        } finally {
            g.setOrigin(0, 0);
            Host.hudEnd();
        }
    }

    /**
     * port: replaces ao.a(Graphics, av, int, int), the 2D sky behind outdoor areas; its one call
     * (in bp) is redirected here by tools/patch_jar.py. The sky is a 480 pixel panorama (two
     * images) that repeats every 180 degrees and scrolls with the player's heading. Changes from
     * the original: the free-look camera's yaw offset is added to the heading, and the scroll
     * position wraps (the original leaves part of the screen undrawn for headings below zero).
     */
    public static void sky(ao map, Graphics g, av player, int island, int area) {
        if (!map.k || map.n[island][area] == 0) {
            return;
        }
        float heading = FastMath.atan2(player.G.get(10), player.G.get(2));
        if (ax.portCamera != null) {
            heading -= Host.cameraYaw(); // free-look swings the view away from the player's heading
        }
        int x = (int) ((double) heading / 0.375) % 480;
        if (x < 0) {
            x += 480;
        }
        if (x > 240) {
            x -= 240;
            g.drawImage(map.au[0], x, 0);
            g.drawImage(map.au[1], -240 + x, 0);
            return;
        }
        g.drawImage(map.au[0], -240 + x, 0);
        g.drawImage(map.au[1], x, 0);
    }

    /**
     * port: replaces h.R(), "walk forward" (2867/4096 units per frame, 409 while slowed); its one
     * call (in av, the player) is redirected here by tools/patch_jar.py. With direct stick
     * movement the speed follows how far the stick is pushed.
     */
    public static void walk(h who) {
        long speed = who.aq ? 409L : 2867L;
        who.c(0L, 0L, (long) ((float) speed * Host.analogSpeed()));
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
