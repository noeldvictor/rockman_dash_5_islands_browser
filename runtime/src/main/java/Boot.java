import rdash.Host;

/** Entry point of the recompiled game: instantiates the i-appli's AppClass (see the .jam). */
public final class Boot {
    private Boot() {
    }

    public static void main(String[] args) {
        Host.init();
        rdash.GameHooks.frameHook = Mods::frame;
        new RockmanDash_F().start();
    }
}
