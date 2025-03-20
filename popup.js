// Set this flag to true to use mock data.
const useMock = false;

// Local mock data for sample stock symbols.
// These values mimic the structure returned by the Alpha Vantage API.
const mockPrices = {};

const API_KEY = "cfdb55b3-05da-4b66-900d-3f9bec143dd0";

// Helper function to fetch price data for a symbol.
function fetchPriceData(symbol) {
    if (useMock && mockPrices[symbol]) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(mockPrices[symbol]), 200);
      });
    } else {
        const workerUrl = `https://yahoo-stock-api.vercel.app/api/stock/?symbol=${encodeURIComponent(symbol)}&apiKey=${API_KEY}`;
        return fetch(workerUrl).then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }
            return response.json();
        });
    }
}
  
// Utility function to load transactions from chrome.storage.
function loadTransactions(callback) {
    chrome.storage.local.get({ transactions: [] }, (result) => {
        callback(result.transactions);
    });
}
  
// Utility function to save transactions to chrome.storage.
function saveTransactions(transactions, callback) {
    chrome.storage.local.set({ transactions }, callback);
}
  
// Update the transaction list in the UI.
function updateTransactionList() {
    loadTransactions((transactions) => {
        const ul = document.getElementById('transactions');
        ul.innerHTML = "";
        transactions.forEach((tx, index) => {
            const li = document.createElement('li');
            var operation = tx.shares >= 0 ? "buy" : "sell";
            li.textContent = `${tx.symbol} - ${operation} ${Math.abs(tx.shares)} shares @ $${parseFloat(tx.purchasePrice).toFixed(2)}`;

            const removeBtn = document.createElement('button');
            removeBtn.textContent = "Remove";
            removeBtn.className = "remove-btn";
            removeBtn.style.marginLeft = "10px";
            removeBtn.addEventListener('click', () => {
                removeTransaction(index);
            });
            li.appendChild(removeBtn);
            ul.appendChild(li);
        });
    });
}
  
// Remove a transaction at the specified index.
function removeTransaction(indexToRemove) {
    loadTransactions((transactions) => {
        const updatedTransactions = transactions.filter((_, index) => index !== indexToRemove);
        saveTransactions(updatedTransactions, () => {
        updateTransactionList();
        });
    });
}
  
// Add a new transaction when the "Add Transaction" button is clicked.
document.getElementById('addBtn').addEventListener('click', () => {
    const symbol = document.getElementById('symbol').value.trim().toUpperCase();
    const shares = parseFloat(document.getElementById('shares').value);
    const purchasePrice = parseFloat(document.getElementById('purchasePrice').value);

    if (!symbol || isNaN(shares) || isNaN(purchasePrice)) {
        alert("Please enter valid values for symbol, shares, and purchase price.");
        return;
    }

    const newTransaction = { symbol, shares, purchasePrice };

    loadTransactions((transactions) => {
        transactions.push(newTransaction);
        saveTransactions(transactions, () => {
            document.getElementById('symbol').value = "";
            document.getElementById('shares').value = "";
            document.getElementById('purchasePrice').value = "";
            updateTransactionList();
        });
    });
});

// --- CALCULATION: Realized and Paper Gains (FIFO) with Table Output ---
function calculateGains() {
    loadTransactions((transactions) => {
      // Group transactions by symbol.
      const grouped = transactions.reduce((acc, tx) => {
        if (!acc[tx.symbol]) {
          acc[tx.symbol] = [];
        }
        acc[tx.symbol].push(tx);
        return acc;
      }, {});
  
      const symbols = Object.keys(grouped);
      let overallTotalGain = 0;
      let overallValue = 0;
      let overallTrueCost = 0;
      let overallQuantity = 0;
      let completedRequests = 0;
  
      // Clear per-symbol table body.
      const resultsBody = document.getElementById('resultsBody');
      resultsBody.innerHTML = "";
  
      if (!transactions.length) {
        return; // No transactions, exit the function
      }
  
      symbols.forEach((symbol) => {
        fetchPriceData(symbol)
          .then((data) => {
            // Extract the price field from the API response.
            const lastClose = data["price"];
            if (!lastClose) {
              throw new Error("No data returned for " + symbol);
            }
            const currentPrice = parseFloat(lastClose);
            if (isNaN(currentPrice)) {
              throw new Error("Invalid current price for " + symbol);
            }
  
            // --- Calculate remaining shares using FIFO ---
            // Process each transaction in order.
            let fifoQueue = [];
            grouped[symbol].forEach((tx) => {
              const shares = parseFloat(tx.shares);
              const price = parseFloat(tx.purchasePrice);
              if (shares > 0) {
                fifoQueue.push({ shares, price });
              } else if (shares < 0) {
                let saleShares = Math.abs(shares);
                // Check total available shares from FIFO
                const availableShares = fifoQueue.reduce((sum, buyTx) => sum + buyTx.shares, 0);
                // If not enough shares to cover this sale, ignore this sale entirely.
                if (availableShares < saleShares) {
                  return; // Skip processing this sale transaction.
                }
                while (saleShares > 0 && fifoQueue.length > 0) {
                  let buyTx = fifoQueue[0];
                  if (buyTx.shares <= saleShares) {
                    saleShares -= buyTx.shares;
                    fifoQueue.shift();
                  } else {
                    buyTx.shares -= saleShares;
                    saleShares = 0;
                  }
                }
              }
            });
            let remainingShares = fifoQueue.reduce((sum, buyTx) => sum + buyTx.shares, 0);
            const value = currentPrice * remainingShares;
            overallQuantity += remainingShares;
  
            // --- Calculate True Cost ---
            // Process transactions in order, keeping a running total.
            let trueCost = 0;
            let runningTotalShares = 0;
            grouped[symbol].forEach((tx) => {
              const shares = parseFloat(tx.shares);
              const price = parseFloat(tx.purchasePrice);
              if (shares > 0) {
                trueCost += price * shares;
                runningTotalShares += shares;
              } else if (shares < 0) {
                let saleShares = Math.abs(shares);
                // If not enough shares have been bought so far, ignore this sale.
                if (runningTotalShares < saleShares) {
                  return;
                } else {
                  trueCost -= price * saleShares;
                  runningTotalShares -= saleShares;
                }
              }
            });
  
            // --- Calculate Total Gain ---
            // Total Gain = Current Value - True Cost.
            const totalGain = value - trueCost;
  
            overallTotalGain += totalGain;
            overallValue += value;
            overallTrueCost += trueCost;
  
            // Create a new table row for this symbol.
            const tr = document.createElement('tr');
  
            // Column 1: Symbol
            const tdSymbol = document.createElement('td');
            tdSymbol.textContent = symbol;
            tr.appendChild(tdSymbol);
  
            // Column 2: Last (current price)
            const tdLast = document.createElement('td');
            tdLast.textContent = `$${currentPrice.toFixed(2)}`;
            tr.appendChild(tdLast);
  
            // Column 3: Quantity (remaining shares)
            const tdQuantity = document.createElement('td');
            tdQuantity.textContent = remainingShares.toString();
            tr.appendChild(tdQuantity);
  
            // Column 4: Total Gain (with percentage)
            const tdTotalGain = document.createElement('td');
            tdTotalGain.textContent = `$${totalGain.toFixed(2)}`;
            tr.appendChild(tdTotalGain);
  
            // Column 5: Value (current market value)
            const tdValue = document.createElement('td');
            tdValue.textContent = `$${value.toFixed(2)}`;
            tr.appendChild(tdValue);
  
            // Column 6: True Cost
            const tdTrueCost = document.createElement('td');
            if (remainingShares > 0) {
                const costBasis = trueCost / remainingShares;
                tdTrueCost.textContent = `$${trueCost.toFixed(2)} (Basis: $${costBasis.toFixed(2)})`;
            } else {
                tdTrueCost.textContent = `$${trueCost.toFixed(2)}`;
            }
            tr.appendChild(tdTrueCost);
  
            resultsBody.appendChild(tr);
          })
          .catch((err) => {
            console.error(`Error fetching data for ${symbol}:`, err);
            const tr = document.createElement('tr');
            
            // Create error row with 6 columns
            const tdError = document.createElement('td');
            tdError.colSpan = 6;
            tdError.textContent = `${symbol}: Error fetching data`;
            tr.appendChild(tdError);
            resultsBody.appendChild(tr);
          })
          .finally(() => {
            completedRequests++;
            if (completedRequests === symbols.length) {
              // After processing all symbols, append an extra row with overall totals.
              const trOverall = document.createElement('tr');
  
              // Column 1: "TOTAL"
              const tdTotal = document.createElement('td');
              tdTotal.textContent = "TOTAL";
              trOverall.appendChild(tdTotal);
  
              // Column 2: Empty since "Last" doesn't apply.
              const tdEmpty = document.createElement('td');
              tdEmpty.textContent = "";
              trOverall.appendChild(tdEmpty);
  
              // Column 3: Overall Quantity
              const tdOverallQuantity = document.createElement('td');
              tdOverallQuantity.textContent = "";
              trOverall.appendChild(tdOverallQuantity);
  
              // Column 4: Overall Total Gain
              const tdOverallTotalGain = document.createElement('td');
              tdOverallTotalGain.textContent = `$${overallTotalGain.toFixed(2)}`;
              trOverall.appendChild(tdOverallTotalGain);
  
              // Column 5: Overall Value
              const tdOverallValue = document.createElement('td');
              tdOverallValue.textContent = `$${overallValue.toFixed(2)}`;
              trOverall.appendChild(tdOverallValue);
  
              // Column 6: Overall True Cost
              const tdOverallTrueCost = document.createElement('td');
              tdOverallTrueCost.textContent = `$${overallTrueCost.toFixed(2)}`;
              trOverall.appendChild(tdOverallTrueCost);
  
              resultsBody.appendChild(trOverall);
            }
          });
      });
    })
  }
  

// Utility function: Parse a single CSV line (simple parser that handles quoted fields)
function parseCSVLine(text) {
    let result = [];
    let current = '';
    let inQuotes = false;
  
    for (let i = 0; i < text.length; i++) {
      let char = text[i];
  
      if (char === '"') {
        // Toggle inQuotes flag if not an escaped quote.
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        // If not in quotes, the comma marks the end of a field.
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    // Push the last field if any.
    if (current !== '') {
      result.push(current.trim());
    }
    return result;
  }
  
// Function to parse the entire CSV file content into an array of transaction objects.
function parseCSV(contents) {
    let transactions = [];
    // Split file into lines (handle both Unix and Windows line endings)
    let lines = contents.split(/\r\n|\n/);
    if (lines.length === 0) return transactions;
    
    // Assume the first line is the header; skip it.
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue; // Skip empty lines
  
      // Process only lines that start with a date in MM/DD/YYYY format.
      if (!/^\d{2}\/\d{2}\/\d{4}/.test(line)) continue;
  
      // Parse the CSV line.
      let fields = parseCSVLine(line);
  
      // We expect at least 7 fields: [0]: Run Date, [1]: Action, [2]: Symbol, [5]: Quantity, [6]: Price ($)
      if (fields.length < 7) continue;
  
      let action = fields[1].toUpperCase();
      let symbol = fields[2].trim().toUpperCase();
      let quantity = parseFloat(fields[5]);
      let price = parseFloat(fields[6]);
  
      // Validate required fields.
      if (!symbol || isNaN(quantity) || isNaN(price)) continue;
  
      // Determine operation from action text.
      // If action contains "SOLD", then it is a sell (quantity becomes negative).
      if (action.indexOf("SOLD") !== -1) {
        quantity = -Math.abs(quantity);
      }
  
      transactions.push({ symbol, shares: quantity, purchasePrice: price });
    }
  
    // Reverse the array so that the oldest transaction is first.
    return transactions.reverse();
}
  

// CSV Import event handler
document.getElementById('csvFileInput').addEventListener('change', () => {
    const fileInput = document.getElementById('csvFileInput');
    // If no file is selected, simply do nothing.
    if (fileInput.files.length === 0) {
        return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
        const contents = e.target.result;
        const transactions = parseCSV(contents);
        if (transactions.length > 0) {
            loadTransactions((existingTransactions) => {
                const newTransactions = existingTransactions.concat(transactions);
                saveTransactions(newTransactions, () => {
                    updateTransactionList();
                    calculateGains();
                    // Optionally, you can update a status element instead of using alert:
                    console.log("CSV imported successfully!");
                });
            });
        } else {
            console.log("No valid transactions found in the CSV file.");
        }
    };

    reader.onerror = function(e) {
        console.error("Error reading the CSV file.");
    };

    reader.readAsText(file);
});
  
// Bind the calculateGains function to the Calculate button.
document.getElementById('calculateBtn').addEventListener('click', calculateGains);

// Automatically run the calculations on window load.
window.addEventListener('load', () => {
    updateTransactionList();
    calculateGains();
});