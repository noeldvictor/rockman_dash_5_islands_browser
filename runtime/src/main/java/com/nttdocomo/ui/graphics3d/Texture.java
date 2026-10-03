package com.nttdocomo.ui.graphics3d;

import rdash.Host;

public class Texture extends Object3D {
    public static final int MODULATE = 0;
    public static final int REPLACE = 1;

    Texture() {
        super(TYPE_TEXTURE);
    }

    public void setBlendMode(int mode) {
        Host.g3dSetInt(js, "envMode", mode);
    }

    public void setEnvironmentMapEnabled(boolean enabled) {
        Host.g3dSetBool(js, "envMap", enabled);
    }

    public void setEnvironmentMapTexture(Texture t) {
    }
}
