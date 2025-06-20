import React, { useRef, useState, useEffect } from "react";

function App() {
  const [token, setToken] = useState('');
  const [messages, setMessages] = useState([]);
  const [promptPairs, setPromptPairs] = useState([]);
  const wsRef = useRef(null);
  const micStreamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceRef = useRef(null);
  const audioCtxRef = useRef(null);
  const chunkBuffer = useRef([]);
  const CHUNKS_PER_PLAY = 29;
  const nextPlayTimeRef = useRef(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Move this here (top level, not inside startFlow)
  const lastPromptRef = useRef(null);

  // Fetch token from API
  const fetchToken = async () => {
    try {
      const res = await fetch(
        "https://mp.speechmatics.com/v1/api_keys?type=flow",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer BobV7bt1v8GvUIrqkJWOWJGJknyIjpES"
          },
          body: JSON.stringify({ ttl: 360 })
        }
      );
      const data = await res.json();
      if (data.key_value) setToken(data.key_value);
    } catch (err) {
      alert("Failed to fetch token");
    }
  };

  // AudioWorklet processor registration (inline for simplicity)
  useEffect(() => {
    if (!window.AudioWorkletNodeRegistered) {
      window.AudioWorkletNodeRegistered = true;
      const blob = new Blob([`
        class PCMProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0][0];
            if (input) {
              const int16Buffer = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++) {
                int16Buffer[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
              }
              this.port.postMessage(int16Buffer.buffer, [int16Buffer.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      window.pcmProcessorUrl = url;
    }
  }, []);

  const startFlow = async () => {
    if (!token.trim()) {
      alert('Please enter a JWT token.');
      return;
    }

    const ws = new WebSocket(`wss://flow.api.speechmatics.com/v1/flow?jwt=${token}&assistant=3668c60a-1c08-4670-81e9-97e12e5a4149:latest&ssl-mode=insecure`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = async () => {
      ws.send(JSON.stringify({
        message: "StartConversation",
        audio_format: {
          type: "raw",
          encoding: "pcm_s16le",
          sample_rate: 16000
        },
        conversation_config: {
          template_id: "3668c60a-1c08-4670-81e9-97e12e5a4149:latest"
        }
      }));

      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = micStream;
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;
        await audioCtx.audioWorklet.addModule(window.pcmProcessorUrl);
        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
        workletNodeRef.current = workletNode;

        workletNode.port.onmessage = (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(event.data);
          }
        };

        sourceRef.current = audioCtx.createMediaStreamSource(micStream);
        sourceRef.current.connect(workletNode).connect(audioCtx.destination);
      } catch (err) {
        alert('Error accessing microphone: ' + err.message);
      }
    };

    ws.onmessage = (event) => {
      console.log(event.data);

      if (typeof event.data === 'string') {
        try {
          const obj = JSON.parse(event.data);
          // --- Track last prompt and add pair on ResponseCompleted ---
          if (obj.message === "prompt") {
            lastPromptRef.current = obj.prompt?.prompt || "";
          }
          if (obj.message === "ResponseCompleted" && lastPromptRef.current) {
            setPromptPairs(pairs => [
              ...pairs,
              {
                prompt: lastPromptRef.current,
                response: obj.content || ""
              }
            ]);
            lastPromptRef.current = null;
          }
          setMessages(msgs => [...msgs, event.data]);
        } catch {
          // Not JSON, ignore or handle as needed
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Log the first few bytes for inspection
        const uint8 = new Uint8Array(event.data);
        console.log('Binary message received:', uint8.slice(0, 16)); // Logs first 16 bytes

        setMessages(msgs => [
          ...msgs,
          `[Binary message received] First bytes: ${Array.from(uint8.slice(0, 16)).join(', ')}`
        ]);
        playAudioChunk(event.data);
      }
    };

    ws.onclose = stopFlow;
    ws.onerror = stopFlow;
  };

  const stopFlow = () => {
    if (workletNodeRef.current) workletNodeRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioCtxRef.current) audioCtxRef.current.close();
    if (wsRef.current) wsRef.current.close();
    nextPlayTimeRef.current = 0;
  };

  const clearAll = () => {
    setMessages([]);
  };

  function playAudioChunk(arrayBuffer) {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      nextPlayTimeRef.current = 0;
    }
    const flowAudioContext = audioCtxRef.current;

    const dataView = new DataView(arrayBuffer);
    const float32Array = new Float32Array(arrayBuffer.byteLength / 2);
    for (let i = 0; i < float32Array.length; i++) {
      const int16 = dataView.getInt16(i * 2, true);
      float32Array[i] = int16 / 32768;
    }

    const audioBuffer = flowAudioContext.createBuffer(1, float32Array.length, 16000);
    audioBuffer.copyToChannel(float32Array, 0);
    const source = flowAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(flowAudioContext.destination);

    source.playbackRate.value = playbackSpeed;

    const currentTime = flowAudioContext.currentTime;
    if (nextPlayTimeRef.current < currentTime) {
      nextPlayTimeRef.current = currentTime;
    }
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration / playbackSpeed;

    source.onended = () => {
      source.disconnect();
    };
  }

  return (
    <div style={{ padding: 20, fontFamily: 'Arial, sans-serif', maxWidth: 800, margin: 'auto' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 20 }}>Speechmatics Flow Demo (Basic)</h2>
      
      <div>
        <label style={{ fontWeight: 'bold', fontSize: 16 }}>
          JWT Token:{' '}
          <input
            type="text"
            value={token}
            onChange={e => setToken(e.target.value)}
            style={{ width: '100%', maxWidth: 600, padding: 8, fontSize: 14, marginTop: 5 }}
            placeholder="Enter your JWT token here"
            id="token-input"
          />
        </label>
        <button
          onClick={fetchToken}
          style={{ marginLeft: 10, padding: '8px 16px', fontSize: 14 }}
        >
          Update Token
        </button>
        <button
          onClick={() => {
            // Copy token to clipboard
            if (navigator.clipboard) {
              navigator.clipboard.writeText(token);
              alert("Token copied to clipboard!");
            } else {
              // fallback for older browsers
              const input = document.getElementById("token-input");
              input.select();
              document.execCommand("copy");
              alert("Token copied to clipboard!");
            }
          }}
          style={{ marginLeft: 10, padding: '8px 16px', fontSize: 14 }}
        >
          Copy Token
        </button>
      </div>
      <div style={{ marginTop: 15 }}>
        <button onClick={startFlow} style={{ padding: '8px 16px', fontSize: 14, cursor: 'pointer' }}>Start</button>
        <button onClick={stopFlow} style={{ marginLeft: 10, padding: '8px 16px', fontSize: 14, cursor: 'pointer' }}>Stop</button>
      <button onClick={clearAll} style={{ marginLeft: 10, padding: '8px 16px', fontSize: 14, cursor: 'pointer' }}>Clear</button>
      </div>
      <div style={{ marginTop: 30 }}>
        <label style={{ fontWeight: 'bold', fontSize: 16 }}>Playback Speed: </label>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={playbackSpeed}
          onChange={e => setPlaybackSpeed(parseFloat(e.target.value))}
          style={{ width: 200, verticalAlign: 'middle', marginLeft: 10 }}
        />
        <span style={{ marginLeft: 10 }}>{playbackSpeed.toFixed(1)}x</span>
      </div>
      <div style={{ marginTop: 30 }}>
        <h3 style={{ borderBottom: '2px solid #333', paddingBottom: 5 }}>Prompt/Response (ResponseCompleted only):</h3>
        <div
          style={{
            color: '#222',
            background: '#e6f7ff',
            padding: 15,
            minHeight: 100,
            maxHeight: 300,
            overflowY: 'auto',
            fontFamily: 'monospace',
            borderRadius: 6,
            boxShadow: '0 0 5px rgba(0,0,0,0.1)'
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #aaa', padding: '4px 8px' }}>Prompt</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #aaa', padding: '4px 8px' }}>Response</th>
              </tr>
            </thead>
            <tbody>
              {promptPairs.map((pair, i) => (
                <tr key={i}>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #eee', wordBreak: 'break-all' }}>{pair.prompt}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #eee', wordBreak: 'break-all' }}>{pair.response}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ marginTop: 30 }}>
        <h3 style={{ borderBottom: '2px solid #333', paddingBottom: 5 }}>All Messages:</h3>
        <pre 
          style={{
            color: '#222',
            background: '#f9f9f9',
            padding: 15,
            minHeight: 200,
            maxHeight: 400,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            borderRadius: 6,
            boxShadow: '0 0 5px rgba(0,0,0,0.1)'
          }}
        >
          {messages.map((msg, i) => (
            <div key={i}>{msg}</div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default App;
