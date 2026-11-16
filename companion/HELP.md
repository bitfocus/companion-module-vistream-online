## ViStream.online Companion module

ViStream.online is the first real-time CMS for event operators. All participants can be cue-controlled through an event.

[https://www.vistream.online](https://www.vistream.online?src=companion)

### Configuration

- Add a Cuelist module on the ViStream platform.
- Edit the module and copy the Bitfocus Companion token.
- Add the token to the corresponding Companion setup field and save it.

### Actions

One action per talk of the event. Choose the module of the talk, then one of its actions (show or hide a module, start or stop the stream, start a cue, …).

### Feedbacks

One feedback per talk. Choose the module, then one of its states (module live, stream, recording, presentation, cue, …). Modules can add their own feedbacks, for example the audio levels of a ViStreamer route.

### Presets

One section per talk with groups per module or category (Modules, Regie, …). Button texts use variables, so they follow renamed modules and cues.

### Variables

Names of modules and cues, stream and recording state, participants, current slide, on-air names and more, depending on the modules of the event. `websocket` shows whether the connection to the platform is online.

### Updates

The module loads all definitions when it connects. Afterwards the platform only sends what changed. Modules can also send small scripts that run inside this connection, for example to read audio levels from a ViStreamer on the same computer.
