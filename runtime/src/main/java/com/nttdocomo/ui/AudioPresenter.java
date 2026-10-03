package com.nttdocomo.ui;

import rdash.Host;

public class AudioPresenter implements MediaPresenter {
    public static final int AUDIO_PLAYING = 1;
    public static final int AUDIO_STOPPED = 2;
    public static final int AUDIO_COMPLETE = 3;
    public static final int AUDIO_SYNC = 4;
    public static final int AUDIO_PAUSED = 5;
    public static final int AUDIO_RESTARTED = 6;
    public static final int AUDIO_LOOPED = 7;
    public static final int PRIORITY = 1;
    public static final int SYNC_MODE = 2;
    public static final int TRANSPOSE_KEY = 3;
    public static final int SET_VOLUME = 4;
    public static final int CHANGE_TEMPO = 5;
    public static final int LOOP_COUNT = 6;
    public static final int ATTR_SYNC_OFF = 0;
    public static final int ATTR_SYNC_ON = 1;
    public static final int MIN_PRIORITY = 1;
    public static final int NORM_PRIORITY = 5;
    public static final int MAX_PRIORITY = 10;

    private static final AudioPresenter[] ports = new AudioPresenter[32];

    private final int port;
    private MediaSound sound;
    private MediaListener listener;

    protected AudioPresenter() {
        this(0);
    }

    AudioPresenter(int port) {
        this.port = port;
    }

    public static AudioPresenter getAudioPresenter() {
        return getAudioPresenter(0);
    }

    public static AudioPresenter getAudioPresenter(int port) {
        if (port < 0 || port >= ports.length) {
            throw new IllegalArgumentException("port " + port);
        }
        if (ports[port] == null) {
            ports[port] = new AudioPresenter(port);
        }
        return ports[port];
    }

    public void setSound(MediaSound sound) {
        this.sound = sound;
        Host.audioSetSound(port, sound == null ? null : ((MediaManager.SoundResource) sound).js);
    }

    public MediaResource getMediaResource() {
        return sound;
    }

    public void play() {
        Host.audioPlay(port);
    }

    public void play(int time) {
        Host.audioPlay(port);
    }

    public void stop() {
        Host.audioStop(port);
    }

    public void pause() {
        Host.audioStop(port);
    }

    public void restart() {
        Host.audioPlay(port);
    }

    public int getCurrentTime() {
        return 0;
    }

    public void setAttribute(int attr, int value) {
        Host.audioSetAttribute(port, attr, value);
    }

    public void setMediaListener(MediaListener listener) {
        this.listener = listener;
    }

    /** Called by the host: playback state changes (AUDIO_* event codes). */
    public static void dispatch(int port, int event, int param) {
        AudioPresenter p = port >= 0 && port < ports.length ? ports[port] : null;
        if (p != null && p.listener != null) {
            p.listener.mediaAction(p, event, param);
        }
    }
}
