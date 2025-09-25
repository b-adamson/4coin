import Image from "next/image";

export default function SiteBanner() {
  return (
    <div style={{ width: "100%", overflow: "hidden" }}>
      <Image
        src="/banner.png" 
        alt="4coin logo"
        width={2560}
        height={500}
        priority
        style={{
          width: "100%",  
          height: "auto",   
          display: "block",
          margin: "0 auto",
        }}
      />
    </div>
  );
}
