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
    public static void sleep(long millis) throws InterruptedException {
        if (Host.isLoading()) {
            return;
        }
        Thread.sleep(millis);
    }
}
