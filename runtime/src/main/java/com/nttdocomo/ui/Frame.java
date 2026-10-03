package com.nttdocomo.ui;

import rdash.Host;

public abstract class Frame {
    public static final int SOFT_KEY_1 = 0;
    public static final int SOFT_KEY_2 = 1;

    public Frame() {
    }

    public final int getHeight() {
        return Display.getHeight();
    }

    public final int getWidth() {
        return Display.getWidth();
    }

    public void setBackground(int color) {
    }

    public void setSoftLabel(int key, String label) {
        Host.softLabel(key, label);
    }

    public void setSoftLabelVisible(boolean visible) {
    }
}
