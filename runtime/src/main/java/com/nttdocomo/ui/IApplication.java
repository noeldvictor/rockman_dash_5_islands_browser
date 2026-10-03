package com.nttdocomo.ui;

import rdash.Host;

public abstract class IApplication {
    public static final int LAUNCHED_FROM_MENU = 0;
    public static final int LAUNCH_BROWSER = 1;
    public static final int LAUNCH_VERSIONUP = 2;
    public static final int LAUNCH_IAPPLI = 3;

    private static IApplication current;

    public IApplication() {
        current = this;
    }

    public static final IApplication getCurrentApp() {
        return current;
    }

    /** The .jam AppParam entry, split on spaces. */
    public final String[] getArgs() {
        String p = Host.appParam("AppParam");
        if (p == null || p.trim().length() == 0) {
            return new String[0];
        }
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        int i = 0;
        p = p.trim();
        while (i < p.length()) {
            int j = p.indexOf(' ', i);
            if (j < 0) {
                j = p.length();
            }
            if (j > i) {
                out.add(p.substring(i, j));
            }
            i = j + 1;
        }
        return out.toArray(new String[0]);
    }

    public final String getParameter(String name) {
        return Host.appParam(name);
    }

    public abstract void start();

    public void resume() {
    }

    public final void terminate() {
        Host.terminate();
    }

    /** Directory part of the .jam PackageURL. */
    public final String getSourceURL() {
        String url = Host.appParam("PackageURL");
        if (url == null) {
            return "";
        }
        int i = url.lastIndexOf('/');
        return i < 0 ? "" : url.substring(0, i + 1);
    }

    public final int getLaunchType() {
        return LAUNCHED_FROM_MENU;
    }

    public final void launch(int target, String[] args) {
        Host.log("IApplication.launch(" + target + ", " + (args != null && args.length > 0 ? args[0] : "") + ") ignored");
    }

    public int getSuspendInfo() {
        return 0;
    }
}
