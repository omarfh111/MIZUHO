export default function StoredWaterOnly({ onApply }: { onApply: () => void }) {
  return <div className="stock-only-example">
    <div><strong>What if no more water can be withdrawn today?</strong>
      <p>Keep your starting stock and delivery commitments. Test zero withdrawals with the grid available.</p></div>
    <button type="button" className="button button-secondary" onClick={onApply}>Use stored water only</button>
  </div>;
}
