package com.nttdocomo.ui;

public class PhoneSystem {
    public static final int DEV_BACKLIGHT = 0;
    public static final int DEV_VIBRATOR = 1;
    public static final int ATTR_VIBRATOR_OFF = 0;
    public static final int ATTR_VIBRATOR_ON = 1;
    public static final int ATTR_BACKLIGHT_OFF = 0;
    public static final int ATTR_BACKLIGHT_ON = 1;

    private PhoneSystem() {
    }

    public static void setAttribute(int attr, int value) {
        if (attr == DEV_VIBRATOR) {
            rdash.Host.vibrate(value != ATTR_VIBRATOR_OFF);
        }
    }

    public static int getAttribute(int attr) {
        return 0;
    }

    public static boolean isAvailable(int attr) {
        return true;
    }

    public static void playSound(int type) {
    }
}
