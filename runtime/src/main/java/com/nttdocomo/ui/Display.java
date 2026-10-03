package com.nttdocomo.ui;

public class Display {
    public static final int KEY_PRESSED_EVENT = 0;
    public static final int KEY_RELEASED_EVENT = 1;
    public static final int RESUME_VM_EVENT = 4;
    public static final int RESET_VM_EVENT = 5;
    public static final int UPDATE_VM_EVENT = 6;
    public static final int TIMER_EXPIRED_EVENT = 7;
    public static final int MEDIA_EVENT = 8;
    public static final int KEY_0 = 0;
    public static final int KEY_1 = 1;
    public static final int KEY_2 = 2;
    public static final int KEY_3 = 3;
    public static final int KEY_4 = 4;
    public static final int KEY_5 = 5;
    public static final int KEY_6 = 6;
    public static final int KEY_7 = 7;
    public static final int KEY_8 = 8;
    public static final int KEY_9 = 9;
    public static final int KEY_ASTERISK = 10;
    public static final int KEY_POUND = 11;
    public static final int KEY_LEFT = 16;
    public static final int KEY_UP = 17;
    public static final int KEY_RIGHT = 18;
    public static final int KEY_DOWN = 19;
    public static final int KEY_SELECT = 20;
    public static final int KEY_SOFT1 = 21;
    public static final int KEY_SOFT2 = 22;
    public static final int KEY_IAPP = 24;

    private static Frame current;

    private Display() {
    }

    public static final Frame getCurrent() {
        return current;
    }

    public static final void setCurrent(Frame frame) {
        current = frame;
    }

    public static final int getWidth() {
        return 240;
    }

    public static final int getHeight() {
        return 240;
    }

    public static final boolean isColor() {
        return true;
    }

    public static final int numColors() {
        return 1 << 24;
    }

    /** Called by the host for every key transition. */
    public static void dispatchKey(int type, int key) {
        if (current instanceof Canvas) {
            ((Canvas) current).processEvent(type, key);
        }
    }
}
