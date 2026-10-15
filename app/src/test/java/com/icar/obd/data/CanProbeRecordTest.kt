package com.icar.obd.data
import com.icar.obd.obd.CanFrame
import org.junit.Assert.*
import org.junit.Test
class CanProbeRecordTest {
    @Test fun `terminal record retains candidate decode and observed values`() {
        val acc=CanFrame.Accumulator();acc.feedLine("09A 00",1);acc.feedLine("09A 04",2)
        val p=PidDefinition(id="candidate",name="候选灯",mode="MON",source="monitor",header="09A",formula="bit(A,2)",enabled=false)
        val text=CanProbeRecord.decode(acc.aggregates(),listOf(p))
        assertTrue(text.contains("0x09A"));assertTrue(text.contains("候选灯"));assertTrue(text.contains("候选"))
        assertTrue(text.contains("00 | 04"));assertFalse(text.contains("**"))
    }
    @Test fun `unbound records do not invent physical values`() {
        val acc=CanFrame.Accumulator();acc.feedLine("09A 00",1)
        assertEquals("",CanProbeRecord.decode(acc.aggregates(),emptyList()))
    }
}
