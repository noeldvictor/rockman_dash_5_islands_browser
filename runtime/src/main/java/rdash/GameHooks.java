package rdash;

/**
 * Targets of calls redirected in the game's bytecode at build time (tools/patch_jar.py).
 */
public final class GameHooks {
    private GameHooks() {
    }

    /**
     * Replaces Thread.sleep in the game. Its only use is the 15 fps frame limiter; while a
     * loading screen is up (the game spreads loading over many frames behind a progress bar) the
     * wait is skipped, so loading takes a few seconds instead of half a minute.
     */
    /** Run once per game frame (set by Boot; the game's classes are in the default package). */
    public static Runnable frameHook;

    /** Called after every frame the game presents. */
    public static void frame() {
        if (frameHook != null) {
            frameHook.run();
        }
    }

    public static void sleep(long millis) throws InterruptedException {
        if (Host.isLoading()) {
            return;
        }
        Thread.sleep(millis);
    }
}
