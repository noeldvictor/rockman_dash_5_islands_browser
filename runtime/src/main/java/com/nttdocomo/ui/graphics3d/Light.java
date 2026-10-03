package com.nttdocomo.ui.graphics3d;

public class Light extends Object3D {
    public static final int AMBIENT = 128;
    public static final int DIRECTIONAL = 129;
    public static final int OMNI = 130;
    public static final int SPOT = 131;

    public Light() {
        super(TYPE_LIGHT);
    }
}
