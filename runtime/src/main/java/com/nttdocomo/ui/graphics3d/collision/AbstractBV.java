package com.nttdocomo.ui.graphics3d.collision;

public abstract class AbstractBV extends AbstractShape implements BoundingVolume {
    AbstractBV(int shapeType) {
        super(shapeType);
    }
}
