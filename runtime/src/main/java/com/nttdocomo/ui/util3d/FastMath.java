package com.nttdocomo.ui.util3d;

/** Angles are in degrees, as everywhere in the DoJa 3D API. */
public class FastMath {
    private static final float RAD = (float) (Math.PI / 180.0);
    private static final float DEG = (float) (180.0 / Math.PI);

    private FastMath() {
    }

    public static int floatToInnerInt(float f) {
        return (int) (f * 4096f);
    }

    public static float innerIntToFloat(int i) {
        return i / 4096f;
    }

    public static float add(float a, float b) {
        return a + b;
    }

    public static float sub(float a, float b) {
        return a - b;
    }

    public static float mul(float a, float b) {
        return a * b;
    }

    public static float div(float a, float b) {
        return a / b;
    }

    public static float sqrt(float a) {
        return (float) Math.sqrt(a);
    }

    public static float sin(float a) {
        return (float) Math.sin(a * RAD);
    }

    public static float cos(float a) {
        return (float) Math.cos(a * RAD);
    }

    public static float tan(float a) {
        return (float) Math.tan(a * RAD);
    }

    public static float asin(float a) {
        return (float) Math.asin(a) * DEG;
    }

    public static float acos(float a) {
        return (float) Math.acos(a) * DEG;
    }

    public static float atan(float a) {
        return (float) Math.atan(a) * DEG;
    }

    public static float atan2(float y, float x) {
        return (float) Math.atan2(y, x) * DEG;
    }

    public static float abs(float a) {
        return a < 0 ? -a : a;
    }
}
