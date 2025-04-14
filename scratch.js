  async function submitPackage(commitHex, revealHex) {
    const url = `http://localhost:1081/submit_package`;

    console.log(JSON.stringify([commitHex, revealHex]));
  //   const payload = {
  //     tx_hexs: [commitHex, revealHex]
  // };
    const payload = [commitHex, revealHex];

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.log(response);
      let text = await response.text();
      console.log(text);
      throw new Error(`Failed to broadcast transactions: ${response.statusText}`);
    }

    const data = await response.text();
    return data;
  }


  submitPackage("hello lmao", "hello lmao2")